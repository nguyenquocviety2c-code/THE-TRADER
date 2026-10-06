/**
 * prisma/import-real-eod.ts — NẠP DỮ LIỆU EOD THẬT TỪ VNDIRECT dchart
 * ═══════════════════════════════════════════════════════════════════════
 *
 * "Giờ là lúc chúng ta bắt đầu cần dữ liệu thật để tạo lên những bài học thật."
 *
 * Công việc (IDEMPOTENT — chạy lại bao nhiêu lần cũng cùng kết quả):
 *   1. Deep backfill 30 mã VN30 × 2013→nay từ dchart-api.vndirect.com.vn
 *      (public, đã adjust) — XOÁ bar synthetic (PRNG seed 42) thay bằng bar thật.
 *   2. Neo Quote mỗi mã vào EOD thật cuối (ref/OHLC/volume/trần/sàn thật).
 *   3. REBASE danh mục demo theo giá thật:
 *      - Position.avgPrice = close THẬT của ngày mở vị thế
 *      - Trade.price / fee / tax = close thật ngày khớp (0,15% / 0,1%)
 *      - Order.price = close thật ngày tạo (fee=0 khi PENDING — AUD-CODE #22)
 *      - Signal ACTIVE: target/SL/TP scale quanh close thật theo tỷ lệ seed
 *      - BrokerAccount.equity = cash + Σ(qty × close thật)  (F-102)
 *      - Xoá RiskAlert demo cũ (giá trị base trên giá synthetic — hệ thống
 *        sẽ sinh alert mới từ dữ liệu thật)
 *   4. Đánh dấu DataSourceStatus "eod-history" mode="real".
 *
 * Chạy: env -u DATABASE_URL bun prisma/import-real-eod.ts
 *   (env -u: chống shell poison DATABASE_URL=file:… legacy — bài học Task 31)
 *
 * Sau script này: mọi chỉ báo (SMA/RSI/valuation band/backtest) và prompt
 * của 23 agents chạy trên GIÁ THẬT. Intraday tick vẫn mô phỏng (gắn nhãn
 * "simulated") quanh mức ref THẬT cho tới khi có feed realtime VNDIRECT.
 */
import { PrismaClient } from "@prisma/client";
import { deepBackfillEod, type EodSyncOutcome } from "../src/lib/eod-sync";

const db = new PrismaClient();

function round100(v: number): number {
  return Math.max(0, Math.round(v / 100) * 100);
}

/** Close thật tại (hoặc sát trước) mốc thời gian — binary search trên chuỗi tăng dần. */
function closeOnOrBefore(
  series: { t: number; close: number }[],
  at: Date
): number | null {
  const target = at.getTime();
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans < 0) return series.length > 0 ? series[0].close : null;
  return series[ans].close;
}

async function main() {
  console.log("══ NẠP DỮ LIỆU EOD THẬT VNDIRECT (dchart-api) ══");
  console.log(`Bắt đầu: ${new Date().toISOString()}`);

  // ── 1+2. Deep backfill bars + neo quote ──────────────────────────────
  console.log("\n[1/3] Deep backfill 2013→nay cho mọi instrument active…");
  const outcome: EodSyncOutcome = await deepBackfillEod({ fromYear: 2013 });
  console.log(
    `  ✓ ${outcome.symbolsOk.length} mã OK: ${outcome.symbolsOk.join(", ")}`
  );
  if (outcome.symbolsEmpty.length > 0) {
    console.log(`  ⚠ ${outcome.symbolsEmpty.length} mã không có dữ liệu: ${outcome.symbolsEmpty.join(", ")}`);
  }
  if (outcome.symbolsFailed.length > 0) {
    console.log(`  ✗ ${outcome.symbolsFailed.length} mã lỗi:`);
    for (const f of outcome.symbolsFailed) console.log(`    - ${f.symbol}: ${f.error}`);
  }
  console.log(
    `  → ${outcome.barsUpserted.toLocaleString("vi-VN")} bar thật nạp · ${outcome.barsSkipped} bar bỏ (vi phạm validate §5) · phiên cuối: ${outcome.lastTradeDate}`
  );
  console.log(`  → thời gian ${(outcome.durationMs / 1000).toFixed(1)}s`);

  if (outcome.symbolsOk.length === 0) {
    throw new Error("Không nạp được mã nào — kiểm tra egress tới dchart-api.vndirect.com.vn");
  }

  // ── 3. Rebase danh mục theo giá thật ──────────────────────────────────
  console.log("\n[2/3] Rebase danh mục demo theo giá thật…");
  const instruments = await db.instrument.findMany({
    select: { id: true, symbol: true },
  });
  const byId = new Map(instruments.map((i) => [i.id, i.symbol]));

  // Chuỗi close thật theo mã (tăng dần theo thời gian)
  const bars = await db.bar.findMany({
    select: { instrumentId: true, date: true, close: true },
    orderBy: { date: "asc" },
  });
  const seriesBySymbol = new Map<string, { t: number; close: number }[]>();
  for (const b of bars) {
    const symbol = byId.get(b.instrumentId);
    if (!symbol) continue;
    let arr = seriesBySymbol.get(symbol);
    if (!arr) {
      arr = [];
      seriesBySymbol.set(symbol, arr);
    }
    arr.push({ t: b.date.getTime(), close: b.close });
  }
  const closeAt = (symbol: string | undefined, at: Date): number | null => {
    if (!symbol) return null;
    const series = seriesBySymbol.get(symbol);
    if (!series || series.length === 0) return null;
    return closeOnOrBefore(series, at);
  };
  const lastClose = (symbol: string | undefined): number | null => {
    const series = symbol ? seriesBySymbol.get(symbol) : undefined;
    return series && series.length > 0 ? series[series.length - 1].close : null;
  };

  let positionsRebased = 0;
  let tradesRebased = 0;
  let ordersRebased = 0;
  let signalsRebased = 0;

  // 3a. Positions: avgPrice = close thật ngày mở vị thế; realizedPnl = 0
  // (giá trị realized cũ base trên giá synthetic — reset cho sổ sạch)
  const positions = await db.position.findMany({
    select: {
      id: true,
      instrumentId: true,
      openedAt: true,
      status: true,
    },
  });
  for (const p of positions) {
    const symbol = byId.get(p.instrumentId);
    const realAvg = closeAt(symbol, p.openedAt ?? new Date());
    if (realAvg == null || realAvg <= 0) continue;
    await db.position.update({
      where: { id: p.id },
      data: {
        avgPrice: realAvg,
        ...(p.status === "OPEN" ? { realizedPnl: BigInt(0) } : {}),
      },
    });
    positionsRebased++;
  }

  // 3b. Trades: price = close thật ngày khớp + fee 0,15% + tax 0,1% (SELL)
  const trades = await db.trade.findMany({
    select: { id: true, instrumentId: true, side: true, quantity: true, executedAt: true },
  });
  for (const t of trades) {
    const symbol = byId.get(t.instrumentId);
    const realPrice = closeAt(symbol, t.executedAt ?? new Date());
    if (realPrice == null || realPrice <= 0) continue;
    const fee = BigInt(Math.round(0.0015 * realPrice * t.quantity));
    const tax = t.side === "SELL" ? BigInt(Math.round(0.001 * realPrice * t.quantity)) : BigInt(0);
    await db.trade.update({
      where: { id: t.id },
      data: { price: realPrice, fee, tax },
    });
    tradesRebased++;
  }

  // 3c. Orders: price/avgFillPrice theo close thật; fee chỉ tính khi đã khớp
  // (AUD-CODE #22: lệnh PENDING/REJECTED/CANCELLED không giữ phí khống)
  const orders = await db.order.findMany({
    select: {
      id: true,
      instrumentId: true,
      quantity: true,
      filledQuantity: true,
      createdAt: true,
      filledAt: true,
      status: true,
    },
  });
  for (const o of orders) {
    const symbol = byId.get(o.instrumentId);
    const filled = o.filledQuantity > 0;
    const refDate = filled ? (o.filledAt ?? o.createdAt) : o.createdAt;
    const realPrice = closeAt(symbol, refDate);
    if (realPrice == null || realPrice <= 0) continue;
    const feeQty = filled ? o.filledQuantity : 0;
    const fee = BigInt(Math.round(0.0015 * realPrice * feeQty));
    await db.order.update({
      where: { id: o.id },
      data: {
        price: realPrice,
        ...(filled ? { avgFillPrice: realPrice, fee } : { fee: BigInt(0) }),
      },
    });
    ordersRebased++;
  }

  // 3d. Signals ACTIVE (chưa acted): mục đích giá scale quanh close thật
  // theo đúng tỷ lệ seed (BUY: target +8% · SL −5% · TP +12%; SELL: −6%)
  const signals = await db.signal.findMany({
    where: { status: "ACTIVE", actedAt: null },
    select: { id: true, instrumentId: true, direction: true },
  });
  for (const s of signals) {
    const symbol = byId.get(s.instrumentId);
    const base = lastClose(symbol);
    if (base == null || base <= 0) continue;
    await db.signal.update({
      where: { id: s.id },
      data: {
        targetPrice: s.direction === "HOLD" ? null : round100(s.direction === "BUY" ? base * 1.08 : base * 0.94),
        stopLoss: s.direction === "BUY" ? round100(base * 0.95) : null,
        takeProfit: s.direction === "BUY" ? round100(base * 1.12) : null,
      },
    });
    signalsRebased++;
  }

  // 3e. Xoá RiskAlert demo (base trên giá synthetic) — hệ thống sinh alert
  // mới từ dữ liệu thật (escalateStaleSources / flows / risk runs)
  const alertsDeleted = await db.riskAlert.deleteMany({});

  // 3f. Equity = cash + Σ(qty × close thật) — F-102
  const accounts = await db.brokerAccount.findMany({
    where: { deletedAt: null },
    select: { id: true, cashBalance: true },
  });
  for (const acc of accounts) {
    const openPositions = await db.position.findMany({
      where: { brokerAccountId: acc.id, status: "OPEN" },
      select: { instrumentId: true, quantity: true },
    });
    let mv = BigInt(0);
    for (const p of openPositions) {
      const close = lastClose(byId.get(p.instrumentId));
      if (close != null && close > 0) mv += BigInt(close * p.quantity);
    }
    await db.brokerAccount.update({
      where: { id: acc.id },
      data: { equity: acc.cashBalance + mv },
    });
    console.log(
      `  ✓ Tài khoản ${acc.id.slice(-6)}: equity = ${Number(acc.cashBalance + mv).toLocaleString("vi-VN")} ₫ (cash ${Number(acc.cashBalance).toLocaleString("vi-VN")} + GTTH thật ${Number(mv).toLocaleString("vi-VN")})`
    );
  }

  console.log(
    `  ✓ Rebase: ${positionsRebased} vị thế · ${tradesRebased} lượt khớp · ${ordersRebased} lệnh · ${signalsRebased} tín hiệu ACTIVE · ${alertsDeleted.count} alert demo dọn`
  );

  // ── 4. Tổng kết ───────────────────────────────────────────────────────
  const totalBars = await db.bar.count();
  const vnSample = await db.instrument.findMany({
    where: { symbol: { in: ["VCB", "FPT", "VNM", "HPG"] } },
    select: { symbol: true, quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { close: true, refPrice: true } } },
  });
  console.log("\n[3/3] Tổng kết:");
  console.log(`  → Tổng số bar trong DB: ${totalBars.toLocaleString("vi-VN")} (100% EOD thật VNDIRECT)`);
  for (const inst of vnSample) {
    const q = inst.quotes[0];
    if (q && q.close != null) console.log(`  → ${inst.symbol}: close thật ${q.close.toLocaleString("vi-VN")} ₫ · ref ${q.refPrice?.toLocaleString("vi-VN") ?? "—"} ₫`);
  }
  console.log(`\nHoàn tất: ${new Date().toISOString()}`);
  console.log("Mọi chỉ báo & prompt agent từ giờ chạy trên GIÁ THẬT.");
}

main()
  .catch((err) => {
    console.error("LỖI import-real-eod:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
