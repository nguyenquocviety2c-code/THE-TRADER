import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { markSource } from "@/lib/sources";
import { loadQuotesPayload } from "@/lib/market-quotes";
import {
  shouldGenerateTicks,
  sessionPhase,
  SESSION_PHASE_LABEL,
  vnDateIso,
  isTradingDay,
} from "@/lib/market-session";
import { getRealtimeRuntime, markRealtimeAttempt } from "@/lib/settings";
import { fetchFinfoLastPrices, type FinfoQuote } from "@/lib/vndirect";

export const dynamic = "force-dynamic";

/**
 * POST /api/market/tick — S4 market-data engine tick (DATA_SOURCES.md §4.2).
 *
 * Trong môi trường demo (không có feed HOSE/HNX realtime), mỗi tick thực hiện
 * random-walk có giới hạn trên quote mới nhất của từng mã, tuân thủ toàn bộ
 * data-quality rules §5:
 *   Q1 — giá làm tròn bội 100 VND
 *   Q2 — luôn nằm trong dải [floorPrice, ceilingPrice] ±7% HOSE
 *   Q3 — khối lượng chỉ tăng (không âm)
 *   Q5 — change = last − refPrice; changePct = change/refPrice × 100
 * Nguồn được đánh dấu mode="simulated" trong DataSourceStatus (không giả mạo
 * "live"). WebSocket mini-service gọi endpoint này định kỳ và broadcast.
 *
 * Phiên #34 — mode runtime từ AppSetting "market-data" (PUT /api/settings,
 * cache in-process 5s — lib/settings.ts): mode=realtime-vndirect và đã nhập
 * credential → TRONG PHIÊN tick kéo giá cuối THẬT từ finfo-api VNDIRECT
 * (throttle ≥30s/lần fetch, cache module-level giữa 2 lần fetch; thất bại →
 * fall back random-walk quanh ref EOD thật, KHÔNG bỏ tick để paper matching
 * engine vẫn chạy) và đánh dấu market-quotes mode="real" provider finfo-vndirect.
 *
 * F-103 (audit 19-a) — EOD rollover: tick đầu tiên của ngày ICT mới sẽ
 *   (1) ghi Bar OHLCV của phiên vừa đóng (chỉ ngày giao dịch, bỏ T7/CN/lễ — Q7)
 *       — CHỈ khi mode=simulated; real-eod/realtime-vndirect: bar EOD do
 *       đồng bộ dchart VNDIRECT sở hữu (POST /api/market/eod-sync), tick
 *       KHÔNG ghi bar synthetic đè lên dữ liệu thật,
 *   (2) kéo refPrice về close phiên trước, mở dải trần/sàn mới ±7%,
 *   (3) reset khối lượng về 0 với ngân sách ngày mới (0,3–9,2 triệu cp)
 *   → simulator không còn tích luỹ volume/changePct vô hạn.
 *
 * AUD-CODE #18 — mutex in-process: 2 tick đồng thời (scheduler + thủ công)
 * trước đây đọc cùng quote rồi update đè nhau (lost-update giá/khối lượng).
 * Giờ mọi POST được xếp hàng tuần tự qua chuỗi Promise module-level.
 *
 * F-206 (audit 19-b) — paper matching engine: khớp toàn phần lệnh
 *   PENDING/PARTIALLY_FILLED khi thị trường vượt điều kiện giá:
 *   BUY khớp khi last ≤ giá đặt · SELL khớp khi last ≥ giá đặt (khớp tại giá đặt).
 *   Mỗi lệnh khớp sinh Trade + cập nhật Position (bình quân giá vốn /
 *   realized P&L) + tiền mặt + equity + AuditLog ORDER_FILLED.
 */

const TICK_DRIFT = 0.004; // ±0.4% mỗi tick
const FEE_RATE = 0.0015; // phí môi giới 0,15% × notional
const TAX_RATE = 0.001; // thuế TNCN 0,1% — chỉ lệnh BÁN

/**
 * real-eod (mặc định): Bar EOD thuộc về nguồn THẬT dchart VNDIRECT — tick chỉ
 * mô phỏng intraday quanh ref thật. Đặt MARKET_DATA_MODE=simulated (hoặc đổi
 * qua PUT /api/settings) để quay lại hành vi cũ (tick tự ghi bar synthetic
 * khi sang ngày mới).
 *
 * Phiên #34: mode runtime đọc từ AppSetting "market-data" (ghi đè env —
 * lib/settings.ts, cache in-process 5s). mode=realtime-vndirect → trong phiên
 * tick kéo giá cuối THẬT từ finfo-api VNDIRECT (throttle ≥30s/lần fetch,
 * giữa 2 lần fetch dùng cache module-level) và KHÔNG ghi bar synthetic khi
 * rollover (bar EOD vẫn do dchart eod-sync sở hữu).
 */

/** AUD-CODE #18: mutex in-process — mọi POST /api/market/tick chạy tuần tự. */
let tickMutex: Promise<NextResponse> = Promise.resolve(null as unknown as NextResponse);

/** Phiên #34 — khoảng cách tối thiểu giữa 2 lần fetch finfo realtime (tick 10s/lần chỉ áp dụng cache). */
const REALTIME_FETCH_INTERVAL_MS = 30_000;

/** Số mã tối đa mỗi lần gọi finfo lastprice (VN30 đủ dùng, tôn trọng nguồn). */
const REALTIME_MAX_SYMBOLS = 30;

/** Timeout mỗi lần fetch finfo trong tick (tick mutex vẫn tuần tự — không chồng lấn). */
const REALTIME_FETCH_TIMEOUT_MS = 10_000;

/**
 * Phiên #34 — cache realtime finfo module-level (chia sẻ giữa các tick trong
 * cùng process; dev hot-reload reset về rỗng — an toàn vì ok=null ép fetch lại).
 * ok=false → mọi tick trước lần fetch kế tiếp fall back random-walk quanh ref
 * EOD thật (KHÔNG bỏ tick — paper matching engine vẫn chạy).
 */
interface RealtimeCacheState {
  lastFetchAt: number;
  quotes: Map<string, FinfoQuote>;
  ok: boolean | null;
  lastError: string | null;
}
const realtimeCache: RealtimeCacheState = {
  lastFetchAt: 0,
  quotes: new Map(),
  ok: null,
  lastError: null,
};

function round100(v: number): number {
  return Math.max(100, Math.round(v / 100) * 100);
}

function jitter(depth: number | null): number | null {
  if (depth == null) return null;
  return Math.max(0, Math.round(depth * (0.92 + Math.random() * 0.16)));
}

/** FNV-1a hash → unit deterministic [0, 1) theo chuỗi khóa. */
function fnvUnit(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/** F-103: ngân sách khối lượng mỗi phiên theo (mã, ngày) — 0,3–9,2 triệu cp, khớp biên độ seed. */
function dailyVolumeTarget(symbol: string, dateIso: string): number {
  return Math.round(300_000 + fnvUnit(`vol|${symbol}|${dateIso}`) * 8_900_000);
}

/** Số tick dự kiến trong 1 ngày khi engine chạy 24/7 theo TICK_MS. */
function expectedTicksPerDay(): number {
  const ms = Number(process.env.TICK_MS ?? 10_000);
  const safe = Number.isFinite(ms) && ms >= 1_000 ? ms : 10_000;
  return Math.max(1, Math.floor(86_400_000 / safe));
}

type Tx = Prisma.TransactionClient;

/** F-105: equity = tiền mặt + giá trị thị trường các vị thế mở (theo giá vừa tick). */
async function recomputeEquity(
  tx: Tx,
  brokerAccountId: string,
  lastByInstrument: Map<string, number>
): Promise<void> {
  const [account, positions] = await Promise.all([
    tx.brokerAccount.findUnique({
      where: { id: brokerAccountId },
      select: { cashBalance: true },
    }),
    tx.position.findMany({
      where: { brokerAccountId, status: "OPEN" },
      select: { instrumentId: true, quantity: true },
    }),
  ]);
  if (!account) return;
  let mv = BigInt(0);
  for (const p of positions) {
    const last = lastByInstrument.get(p.instrumentId);
    if (last != null && last > 0) mv += BigInt(last * p.quantity);
  }
  await tx.brokerAccount.update({
    where: { id: brokerAccountId },
    data: { equity: account.cashBalance + mv },
  });
}

interface FillSnapshot {
  id: string;
  userId: string;
  brokerAccountId: string | null;
  instrumentId: string;
  side: "BUY" | "SELL";
  price: number | null;
  quantity: number;
  filledQuantity: number;
  avgFillPrice: number | null;
  submittedAt: Date | null;
  status: "PENDING" | "PARTIALLY_FILLED";
}

/**
 * Khớp TOÀN PHẦN một lệnh trong transaction: claim PENDING→FILLED (chống
 * race giữa các tick) → Position → tiền mặt → Trade → AuditLog → equity.
 * Trả false nếu lệnh không thể khớp (hết cổ phiếu để bán / mất quyền claim).
 */
async function fillOrder(
  snapshot: FillSnapshot,
  last: number,
  now: Date,
  lastByInstrument: Map<string, number>
): Promise<boolean> {
  const price = snapshot.price;
  const brokerAccountId = snapshot.brokerAccountId;
  if (price == null || price <= 0 || brokerAccountId == null) return false;
  const qty = snapshot.quantity - snapshot.filledQuantity;
  if (qty <= 0) return false;

  return db.$transaction(async (tx) => {
    // ── F-303 (audit 22-a): SELL không đủ cổ phiếu → từ chối lệnh MỘT LẦN ──
    // (trước đây throw INSUFFICIENT_POSITION → retry mỗi tick vĩnh viễn).
    // Hành vi sàn thật: lệnh bán khi không nắm giữ đủ cp bị từ chối.
    const posWhere: Prisma.PositionWhereUniqueInput = {
      brokerAccountId_instrumentId: {
        brokerAccountId,
        instrumentId: snapshot.instrumentId,
      },
    };
    if (snapshot.side === "SELL") {
      const sellPos = await tx.position.findUnique({ where: posWhere });
      if (!sellPos || sellPos.status !== "OPEN" || sellPos.quantity < qty) {
        const rejected = await tx.order.updateMany({
          where: { id: snapshot.id, status: { in: ["PENDING", "PARTIALLY_FILLED"] } },
          data: { status: "REJECTED" },
        });
        if (rejected.count > 0) {
          await tx.auditLog.create({
            data: {
              userId: snapshot.userId,
              action: "ORDER_REJECTED",
              entity: "Order",
              entityId: snapshot.id,
              before: JSON.stringify({
                status: snapshot.status,
                filledQuantity: snapshot.filledQuantity,
              }),
              after: JSON.stringify({
                status: "REJECTED",
                reason: "INSUFFICIENT_POSITION",
                side: "SELL",
                quantity: qty,
                price,
                mode: "paper",
              }),
            },
          });
        }
        return false;
      }
    }

    // Claim: chỉ một tick giữ được quyền chuyển trạng thái → FILLED
    const claimed = await tx.order.updateMany({
      where: {
        id: snapshot.id,
        status: { in: ["PENDING", "PARTIALLY_FILLED"] },
      },
      data: {
        status: "FILLED",
        filledQuantity: snapshot.quantity,
        avgFillPrice: Math.round(
          (snapshot.filledQuantity * (snapshot.avgFillPrice ?? price) + qty * price) /
            (snapshot.filledQuantity + qty)
        ),
        submittedAt: snapshot.submittedAt ?? now,
        filledAt: now,
        fee: BigInt(Math.round(FEE_RATE * price * snapshot.quantity)),
      },
    });
    if (claimed.count === 0) return false;

    const fee = BigInt(Math.round(FEE_RATE * price * qty));
    const tax =
      snapshot.side === "SELL" ? BigInt(Math.round(TAX_RATE * price * qty)) : BigInt(0);

    // ── Position: bình quân giá vốn (BUY) / realized P&L (SELL) ──
    let positionId: string | null = null;
    const existing = await tx.position.findUnique({ where: posWhere });

    if (snapshot.side === "BUY") {
      if (existing && existing.status === "OPEN") {
        const newQty = existing.quantity + qty;
        const newAvg = Math.round(
          (existing.avgPrice * existing.quantity + price * qty) / newQty
        );
        await tx.position.update({
          where: { id: existing.id },
          data: { quantity: newQty, avgPrice: newAvg },
        });
        positionId = existing.id;
      } else {
        const pos = await tx.position.upsert({
          where: posWhere,
          create: {
            brokerAccountId,
            instrumentId: snapshot.instrumentId,
            quantity: qty,
            avgPrice: price,
            status: "OPEN",
            openedAt: now,
          },
          update: {
            quantity: qty,
            avgPrice: price,
            status: "OPEN",
            openedAt: now,
            closedAt: null,
          },
        });
        positionId = pos.id;
      }
    } else {
      // Đã pre-check F-303 ở đầu tx — nhánh này chỉ chạy khi đủ cp
      if (!existing || existing.status !== "OPEN" || existing.quantity < qty) {
        throw new Error("INSUFFICIENT_POSITION");
      }
      const realized = BigInt((price - existing.avgPrice) * qty);
      const newQty = existing.quantity - qty;
      await tx.position.update({
        where: { id: existing.id },
        data: {
          quantity: newQty,
          realizedPnl: existing.realizedPnl + realized,
          ...(newQty === 0 ? { status: "CLOSED", closedAt: now } : {}),
        },
      });
      positionId = existing.id;
    }

    // ── Tiền mặt: BUY trừ (notional + phí); SELL cộng (notional − phí − thuế) ──
    const account = await tx.brokerAccount.findUnique({
      where: { id: brokerAccountId },
      select: { cashBalance: true },
    });
    if (!account) throw new Error("ACCOUNT_MISSING");
    const notional = BigInt(price * qty);
    const cashDelta =
      snapshot.side === "BUY" ? -(notional + fee) : notional - fee - tax;
    await tx.brokerAccount.update({
      where: { id: brokerAccountId },
      data: { cashBalance: account.cashBalance + cashDelta },
    });

    // ── Trade: phí 0,15% notional, thuế TNCN 0,1% chỉ lệnh BÁN ──
    await tx.trade.create({
      data: {
        orderId: snapshot.id,
        positionId,
        instrumentId: snapshot.instrumentId,
        side: snapshot.side,
        quantity: qty,
        price,
        fee,
        tax,
        executedAt: now,
      },
    });

    // ── Audit F-206: ORDER_FILLED có before/after (F-302: before.status ghi
    // trạng thái THẬT của lệnh trước khi khớp, không hardcode PENDING) ──
    await tx.auditLog.create({
      data: {
        userId: snapshot.userId,
        action: "ORDER_FILLED",
        entity: "Order",
        entityId: snapshot.id,
        before: JSON.stringify({
          status: snapshot.status,
          filledQuantity: snapshot.filledQuantity,
        }),
        after: JSON.stringify({
          status: "FILLED",
          price,
          quantity: qty,
          fee: Number(fee),
          tax: Number(tax),
          mode: "paper",
        }),
      },
    });

    // F-105: equity = tiền mặt + GTTH vị thế mở
    await recomputeEquity(tx, brokerAccountId, lastByInstrument);
    return true;
  });
}

/** AUD-CODE #18: thân tick gốc — chỉ chạy tuần tự qua tickMutex. */
async function runTick(): Promise<NextResponse> {
  try {
    // Phiên #34 — mode runtime từ AppSetting (cache 5s) + bối cảnh realtime
    const rt = await getRealtimeRuntime();
    const mode = rt.mode;
    const realAnchor = mode !== "simulated"; // real-eod | realtime-vndirect: bảng giá neo close thật

    if (!shouldGenerateTicks()) {
      // real-eod/realtime-vndirect: ngoài phiên, bảng giá đang neo ở mức đóng cửa
      // THẬT (eod-sync dchart) — đánh dấu mode "real" thay vì "simulated" cho đúng
      // sự thật hiển thị; trong phiên khi tick chạy sẽ trở lại nguồn tương ứng mode.
      if (realAnchor) {
        await markSource("market-quotes", {
          mode: "real",
          success: true,
          meta: {
            anchoredTo: "real-eod (dchart VNDIRECT)",
            note: "Ngoài phiên — bảng giá neo ở mức đóng cửa thật của phiên cuối",
            strictSession: true,
            ...(mode === "realtime-vndirect"
              ? { realtimePending: "đợi phiên giao dịch — sẽ fetch finfo realtime" }
              : {}),
          },
        });
      }
      const payload = await loadQuotesPayload();
      return NextResponse.json({
        ...payload,
        skipped: true,
        reason: `Ngoài phiên giao dịch (${SESSION_PHASE_LABEL[sessionPhase(new Date())]}) — MARKET_STRICT_SESSION=true`,
      });
    }

    const instruments = await db.instrument.findMany({
      where: { isActive: true },
      select: {
        id: true,
        symbol: true,
        quotes: {
          orderBy: { tradedAt: "desc" },
          take: 1,
          select: {
            id: true,
            open: true,
            high: true,
            low: true,
            last: true,
            volume: true,
            refPrice: true,
            ceilingPrice: true,
            floorPrice: true,
            bidPrice: true,
            askPrice: true,
            bidVolume: true,
            askVolume: true,
            tradedAt: true,
          },
        },
      },
    });

    const now = new Date();
    const todayIso = vnDateIso(now);
    let ticked = 0;
    let rolled = 0;
    let realtimeUsed = 0; // số mã lấy giá THẬT từ finfo trong tick này
    const lastByInstrument = new Map<string, number>();

    // ── Phiên #34: mode realtime-vndirect + đã configured → fetch finfo ──
    // Throttle ≥30s giữa 2 lần fetch; giữa 2 lần fetch các tick 10s/lần chỉ
    // áp dụng cache module-level. Thất bại → markRealtimeAttempt(false) +
    // fall back random-walk (không bỏ tick — paper matching vẫn chạy).
    let rtQuotes: Map<string, FinfoQuote> | null = null;
    let rtFetchAttempted = false;
    if (rt.active) {
      rtFetchAttempted = Date.now() - realtimeCache.lastFetchAt >= REALTIME_FETCH_INTERVAL_MS;
      if (rtFetchAttempted) {
        const symbols = instruments
          .map((i) => i.symbol)
          .slice(0, REALTIME_MAX_SYMBOLS);
        const res = await fetchFinfoLastPrices(
          symbols,
          rt.accessToken || undefined,
          REALTIME_FETCH_TIMEOUT_MS
        );
        realtimeCache.lastFetchAt = Date.now();
        if (res.ok && res.quotes.length > 0) {
          realtimeCache.quotes = new Map(res.quotes.map((fq) => [fq.symbol, fq]));
          realtimeCache.ok = true;
          realtimeCache.lastError = null;
          await markRealtimeAttempt(true);
        } else {
          realtimeCache.ok = false;
          realtimeCache.lastError = res.ok
            ? "finfo phản hồi 200 nhưng không có dòng giá nào"
            : (res.message ?? "lỗi finfo không xác định");
          await markRealtimeAttempt(false);
        }
      }
      rtQuotes = realtimeCache.ok === true ? realtimeCache.quotes : null;
    }

    for (const inst of instruments) {
      const q = inst.quotes[0];
      if (!q || q.last <= 0) continue;

      // ── F-103: EOD rollover khi sang ngày ICT mới ─────────────────
      const prevIso = vnDateIso(q.tradedAt);
      const isRollover = prevIso !== todayIso;

      let ref: number;
      let floor: number;
      let ceiling: number;
      let volumeBase: number;

      if (isRollover) {
        // Ghi Bar OHLCV của phiên vừa đóng — chỉ ngày giao dịch (Q7: bỏ T7/CN/lễ)
        // real-eod/realtime-vndirect: bar EOD thuộc về nguồn THẬT dchart
        // (eod-sync 15:45 ICT upsert bar thật) — tick không ghi bar synthetic
        // đè lên lịch sử thật; chỉ mode "simulated" mới tự ghi bar.
        const barDate = new Date(`${prevIso}T15:00:00.000Z`);
        if (mode === "simulated" && isTradingDay(barDate)) {
          await db.bar.upsert({
            where: { instrumentId_date: { instrumentId: inst.id, date: barDate } },
            create: {
              instrumentId: inst.id,
              date: barDate,
              open: q.open,
              high: q.high,
              low: q.low,
              close: q.last,
              volume: q.volume,
              value: BigInt(Math.max(0, q.volume)) * BigInt(q.last),
            },
            update: {
              open: q.open,
              high: q.high,
              low: q.low,
              close: q.last,
              volume: q.volume,
              value: BigInt(Math.max(0, q.volume)) * BigInt(q.last),
            },
          });
        }
        // Phiên mới: refPrice = close phiên trước, dải ±7% mới, volume về 0
        ref = q.last;
        ceiling = round100(ref * 1.07);
        floor = round100(ref * 0.93);
        volumeBase = 0;
        rolled++;
      } else {
        ref = q.refPrice ?? q.last;
        floor = q.floorPrice ?? round100(ref * 0.93);
        ceiling = q.ceilingPrice ?? round100(ref * 1.07);
        volumeBase = q.volume;
      }

      // ── Phiên #34: chọn nguồn giá — finfo THẬT khi có, random-walk fallback ──
      const rtq = rtQuotes?.get(inst.symbol);
      let next: number;
      let nextVolume: number;
      if (rtq && Number.isFinite(rtq.last) && rtq.last > 0) {
        // Giá cuối THẬT từ finfo — CLAMP vào dải [floorPrice, ceilingPrice]
        // hiện có (±7% quanh ref EOD thật) rồi làm tròn bội 100₫ (Q1/Q2).
        let candidate = rtq.last;
        if (floor > 0 && ceiling > floor) {
          candidate = Math.min(Math.max(candidate, floor), ceiling);
        }
        next = round100(candidate);
        // KLGD dồn phiên THẬT từ finfo (accumulatedVol — Q3: chỉ tăng, không âm)
        nextVolume =
          rtq.volume != null && Number.isFinite(rtq.volume) && rtq.volume >= 0
            ? Math.max(volumeBase, Math.round(rtq.volume))
            : volumeBase;
        realtimeUsed++;
      } else {
        // Random-walk + mean-reversion nhẹ về giá tham chiếu (giữ giá dao động
        // quanh biên độ hợp lý khi simulator chạy nhiều giờ liền)
        const meanPull = ref > 0 ? ((ref - q.last) / ref) * 0.03 : 0;
        const drift = meanPull + (Math.random() * 2 - 1) * TICK_DRIFT;
        let walk = q.last * (1 + drift);
        walk = Math.min(Math.max(walk, floor), ceiling);
        next = round100(walk);

        // F-103: khối lượng có ngân sách ngày — không tích luỹ vô hạn (Q3: chỉ tăng)
        const target = dailyVolumeTarget(inst.symbol, todayIso);
        const cap = Math.max(0, target - volumeBase);
        const baseAdd = target / expectedTicksPerDay();
        const volAdd = Math.min(
          cap,
          Math.max(0, Math.round(baseAdd * (0.4 + Math.random() * 1.2)))
        );
        nextVolume = volumeBase + volAdd;
      }

      const change = next - ref;
      const changePct = ref > 0 ? Number(((change / ref) * 100).toFixed(2)) : 0;

      const spread = Math.max(100, round100(next * 0.001));
      const bidPrice = Math.max(floor, next - spread);
      const askPrice = Math.min(ceiling, next + spread);

      // High/low dồn phiên (PHASE3 B3) — realtime và random-walk cùng pattern
      await db.quote.update({
        where: { id: q.id },
        data: {
          ...(isRollover
            ? { refPrice: ref, ceilingPrice: ceiling, floorPrice: floor }
            : {}),
          open: isRollover ? next : q.open,
          high: Math.max(isRollover ? next : q.high, next),
          low: Math.min(isRollover ? next : q.low, next),
          last: next,
          change,
          changePct,
          volume: nextVolume,
          bidPrice,
          askPrice,
          bidVolume: jitter(q.bidVolume),
          askVolume: jitter(q.askVolume),
          tradedAt: now,
        },
      });
      lastByInstrument.set(inst.id, next);
      ticked++;
    }

    // ── F-105: sang phiên mới → chốt lại equity của mọi tài khoản còn hoạt động ──
    if (rolled > 0) {
      const accounts = await db.brokerAccount.findMany({
        where: { deletedAt: null },
        select: { id: true },
      });
      for (const a of accounts) {
        await recomputeEquity(db, a.id, lastByInstrument);
      }
    }

    // ── F-206: paper matching engine — khớp lệnh chờ khi giá vượt điều kiện ──
    let fills = 0;
    // Where-clause lọc status IN (PENDING, PARTIALLY_FILLED) — thu hẹp kiểu cho FillSnapshot
    const pending = (await db.order.findMany({
      where: {
        status: { in: ["PENDING", "PARTIALLY_FILLED"] },
        price: { not: null },
        brokerAccountId: { not: null },
      },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: {
        id: true,
        userId: true,
        brokerAccountId: true,
        instrumentId: true,
        side: true,
        price: true,
        quantity: true,
        filledQuantity: true,
        avgFillPrice: true,
        submittedAt: true,
        status: true,
      },
    })) as FillSnapshot[];

    for (const order of pending) {
      const last = lastByInstrument.get(order.instrumentId);
      if (last == null || order.price == null) continue;
      const crossed = order.side === "BUY" ? last <= order.price : last >= order.price;
      if (!crossed) continue;
      try {
        const ok = await fillOrder(order, last, now, lastByInstrument);
        if (ok) fills++;
      } catch (err) {
        // INSUFFICIENT_POSITION: lệnh BÁN chưa đủ cp — để chờ, không crash tick
        if (err instanceof Error && err.message === "INSUFFICIENT_POSITION") continue;
        console.error("[api/market/tick:fill]", order.id, err);
      }
    }

    if (fills > 0) {
      await markSource("trading", {
        mode: "paper",
        success: true,
        meta: { fills, lastFillAt: now.toISOString() },
      });
    }

    // ── Phiên #34: đánh dấu nguồn bảng giá theo mode thực sự dùng ──
    if (rt.active) {
      if (realtimeUsed > 0) {
        // Giá THẬT từ finfo realtime (hoặc cache ≤30s của nó)
        await markSource("market-quotes", {
          mode: "real",
          success: true,
          meta: {
            provider: "finfo-vndirect",
            engine: "finfo realtime VNDIRECT (giá cuối phiên thật)",
            realtimeSymbols: realtimeUsed,
            simulatedFallback: ticked - realtimeUsed,
            fetchAttempted: rtFetchAttempted,
            cacheAgeSec: Math.max(
              0,
              Math.round((Date.now() - realtimeCache.lastFetchAt) / 1000)
            ),
            lastError: realtimeCache.lastError,
            band: "±7%",
            strictSession: process.env.MARKET_STRICT_SESSION === "true",
          },
        });
      } else {
        // Fetch finfo thất bại (hoặc trả 0 dòng) → KHÔNG bỏ tick, fall back
        // random-walk quanh ref EOD thật — đánh dấu fallback để UI minh bạch.
        await markSource("market-quotes", {
          mode: "fallback",
          success: false,
          lastError:
            realtimeCache.lastError ?? "finfo realtime không trả báo giá nào",
          meta: {
            provider: "finfo-vndirect",
            note: "Fetch realtime thất bại — tick fall back random-walk quanh ref EOD thật (paper matching vẫn chạy)",
            fetchAttempted: rtFetchAttempted,
            fallbackEngine: "random-walk quanh ref EOD thật",
            band: "±7%",
          },
        });
      }
    } else {
      await markSource("market-quotes", {
        mode: "simulated",
        success: true,
        meta: {
          ticked,
          rolled,
          fills,
          engine:
            mode === "real-eod"
              ? "random-walk quanh ref EOD thật (intraday mô phỏng)"
              : "random-walk+eod-rollover",
          anchoredTo:
            mode === "simulated" ? "synthetic-seed" : "real-eod (dchart VNDIRECT)",
          band: "±7%",
          strictSession: process.env.MARKET_STRICT_SESSION === "true",
        },
      });
    }

    const payload = await loadQuotesPayload();
    return NextResponse.json({
      ...payload,
      ticked,
      rolled,
      fills,
      ...(rt.active ? { realtime: { used: realtimeUsed, fetchAttempted: rtFetchAttempted } } : {}),
    });
  } catch (err) {
    console.error("[api/market/tick]", err);
    return NextResponse.json(
      { error: "Tick bảng giá thất bại." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/market/tick — mọi invocation xếp hàng qua mutex in-process
 * (AUD-CODE #18): hai tick đồng thời đọc cùng quote rồi update đè nhau làm
 * mất giá/khối lượng của nhau; giờ chạy strictly tuần tự.
 */
export async function POST(): Promise<NextResponse> {
  const run = tickMutex.then(runTick).catch((err) => {
    console.error("[api/market/tick:mutex]", err);
    return NextResponse.json(
      { error: "Tick bảng giá thất bại." },
      { status: 500 }
    );
  });
  tickMutex = run;
  return run;
}
