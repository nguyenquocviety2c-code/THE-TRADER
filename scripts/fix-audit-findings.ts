/**
 * scripts/fix-audit-findings.ts — Migration một lần cho các finding audit 19-a/19-b
 *
 * F-101/F-209: clamp Quote (open/high/low/last/bid/ask) vào dải [floorPrice, ceilingPrice]
 *              + sequential clamp Bar OHLC vào ±7% so close hôm trước (Q2 HOSE)
 *              + tính lại change/changePct theo Q5
 * F-207      : set Signal.actedAt cho tín hiệu đã có Order (chặn lệnh trùng)
 * F-102/F-105: tính lại BrokerAccount.equity = cash + Σ(qty × last) (bỏ snapshot seed stale)
 *
 * Chạy: bun scripts/fix-audit-findings.ts  (KHÔNG xóa dữ liệu — chỉ UPDATE tại chỗ)
 */
import { db } from "../src/lib/db";

const round100 = (v: number) => Math.max(0, Math.round(v / 100) * 100);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

async function main() {
  console.log("🔧 Fix audit findings — migration tại chỗ (không xóa dữ liệu)\n");

  // ── 1. Quotes: clamp vào dải trần/sàn + tính lại change/changePct ──
  const quotes = await db.quote.findMany({
    select: {
      id: true, open: true, high: true, low: true, last: true,
      bidPrice: true, askPrice: true, refPrice: true,
      floorPrice: true, ceilingPrice: true, change: true, changePct: true,
    },
  });
  let qFixed = 0;
  for (const q of quotes) {
    const lo = q.floorPrice ?? round100((q.refPrice ?? q.last) * 0.93);
    const hi = q.ceilingPrice ?? round100((q.refPrice ?? q.last) * 1.07);
    const open = clamp(q.open, lo, hi);
    const high = clamp(q.high, lo, hi);
    const low = clamp(q.low, lo, hi);
    const last = clamp(q.last, lo, hi);
    const bid = q.bidPrice != null ? clamp(q.bidPrice, lo, hi) : null;
    const ask = q.askPrice != null ? clamp(q.askPrice, lo, hi) : null;
    const ref = q.refPrice ?? last;
    const change = last - ref;
    const changePct = ref > 0 ? Math.round((change / ref) * 10000) / 100 : 0;
    if (
      open !== q.open || high !== q.high || low !== q.low || last !== q.last ||
      bid !== q.bidPrice || ask !== q.askPrice ||
      change !== q.change || Math.abs(changePct - q.changePct) > 0.005
    ) {
      await db.quote.update({
        where: { id: q.id },
        data: { open, high, low, last, bidPrice: bid, askPrice: ask, change, changePct },
      });
      qFixed++;
    }
  }
  console.log(`  [F-101/F-209] Quotes: ${qFixed}/${quotes.length} row được clamp vào dải ±7% + tính lại change (Q5)`);

  // ── 2. Bars: sequential clamp theo close hôm trước ──
  const instruments = await db.instrument.findMany({ select: { id: true, symbol: true } });
  let bFixed = 0, bTotal = 0;
  for (const inst of instruments) {
    const bars = await db.bar.findMany({
      where: { instrumentId: inst.id },
      orderBy: { date: "asc" },
      select: { id: true, open: true, high: true, low: true, close: true, volume: true, value: true },
    });
    let prevClose = bars[0]?.open ?? 0;
    for (const b of bars) {
      bTotal++;
      const lo = round100(prevClose * 0.93);
      const hi = round100(prevClose * 1.07);
      const open = clamp(b.open, lo, hi);
      const close = clamp(b.close, lo, hi);
      const high = clamp(b.high, Math.min(b.open, b.close, open, close), hi);
      const low = clamp(b.low, lo, Math.max(b.open, b.close, open, close));
      if (open !== b.open || high !== b.high || low !== b.low || close !== b.close) {
        await db.bar.update({
          where: { id: b.id },
          data: { open, high, low, close, value: b.volume * close },
        });
        bFixed++;
      }
      prevClose = close;
    }
  }
  console.log(`  [F-101] Bars: ${bFixed}/${bTotal} bar được clamp vào dải ±7% so close hôm trước`);

  // ── 3. Signals đã có Order → set actedAt (chặn lệnh trùng — F-207) ──
  const signalsWithOrder = await db.signal.findMany({
    where: { actedAt: null, orders: { some: {} } },
    select: { id: true, orders: { orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } } },
  });
  for (const s of signalsWithOrder) {
    await db.signal.update({
      where: { id: s.id },
      data: { actedAt: s.orders[0]?.createdAt ?? new Date() },
    });
  }
  console.log(`  [F-207] Signals: ${signalsWithOrder.length} tín hiệu có lệnh được set actedAt`);

  // ── 4. BrokerAccount.equity = cash + Σ(qty × last) ──
  const accounts = await db.brokerAccount.findMany({ where: { deletedAt: null } });
  for (const acc of accounts) {
    const positions = await db.position.findMany({
      where: { brokerAccountId: acc.id, status: "OPEN" },
      select: { quantity: true, instrument: { select: { quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } } } } },
    });
    const mv = positions.reduce((s, p) => s + p.quantity * (p.instrument.quotes[0]?.last ?? 0), 0);
    const equity = acc.cashBalance + BigInt(mv);
    if (equity !== acc.equity) {
      await db.brokerAccount.update({ where: { id: acc.id }, data: { equity } });
      console.log(`  [F-102/F-105] ${acc.accountNumber}: equity ${acc.equity} → ${equity} (cash + GTTH)`);
    }
  }

  console.log("\n✅ Migration hoàn tất.");
}

main()
  .catch((e) => {
    console.error("❌ Migration lỗi:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
