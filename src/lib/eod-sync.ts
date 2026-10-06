/**
 * src/lib/eod-sync.ts — ĐỒNG BỘ EOD THẬT TỪ VNDIRECT dchart-api (Tier 1 —
 * DATA_SOURCES.md §3.1, public endpoint KHÔNG cần auth).
 *
 * Nguồn: GET https://dchart-api.vndirect.com.vn/dchart/history
 *          ?symbol=VCB&resolution=D&from=<unix-sec>&to=<unix-sec>
 *        → JSON {t[], o[], h[], l[], c[], v[], s:"ok"} (Content-Type
 *          text/plain dù body là JSON — parse thủ công, Gen-1 §3.1)
 *        → GIÁ TRẢ VỀ ĐƠN VỊ NGHÌN VND (VCB 57.3 = 57.300₫) — ×1000 khi ingest.
 *        → t = nửa đêm UTC của ngày giao dịch (đã đối chiếu public.market_data).
 *
 * Golden signature (Gen-1 collectors/vndirect.ts §11 — giữ nguyên chuẩn):
 *   keys ["t","o","h","l","c","v","s"] · s === "ok" · 3 error shapes đã đo:
 *   body rỗng = không có dữ liệu (hợp lệ) · "Not support resolution" = lỗi cấu
 *   hình · 5xx/timeout = retry có backoff.
 *
 * Validate §5 (DATA_SOURCES.md): Q1 bội 100₫ · Q2 dải ±7% không áp cho EOD
 * lịch sử (giá đóng cửa thật có thể vượt dải mô phỏng của ngày khác) · Q3
 * volume ≥ 0 · Q4 upsert idempotent theo @@unique([instrumentId, date]) ·
 * Q6 t UTC → Bar.date 15:00 UTC (convention tick route) · Q7 bỏ T7/CN.
 *
 * Sau khi đồng bộ bar, Quote được NEO LẠI vào EOD thật: refPrice = close phiên
 * trước · OHLC = bar cuối · change/changePct tính từ ref thật · dải trần/sàn
 * ±7% mở theo ref thật · volume = KLGD thật. Intraday tick (nếu bật) chỉ còn
 * vai trò mô phỏng quanh mức thật và luôn gắn nhãn mode="simulated".
 *
 * Dùng bởi: POST /api/market/eod-sync (daily + manual) · prisma/import-real-eod.ts
 * (deep backfill 2013→nay + rebase danh mục) · market-engine scheduler 15:45 ICT.
 */

import { db } from "@/lib/db";
import { markSource } from "@/lib/sources";

export const DCHART_BASE =
  process.env.DCHART_BASE_URL ?? "https://dchart-api.vndirect.com.vn";

/** Giới hạn giá hợp lệ sau ×1000 (VND) — VN30 adjusted 2013→nay, chặn nhiễu nguồn. */
const PRICE_MIN_VND = 500;
const PRICE_MAX_VND = 5_000_000;

/** Khoảng cách tối thiểu giữa 2 request dchart (tôn trọng nguồn công cộng). */
const REQUEST_INTERVAL_MS = 300;

/** Số request tối đa trong 1 chu kỳ sync (30 mã + 2 dự phòng). */
const MAX_SYMBOLS_PER_SYNC = 40;

export interface RealBarInput {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  value: bigint;
}

export interface DchartHistory {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

export type FetchHistoryResult =
  | { empty: true }
  | { empty: false; bars: DchartHistory };

/** Lỗi cấu hình collector (resolution sai / endpoint đổi) — KHÔNG retry mù. */
export class DchartConfigError extends Error {}

/** Response đổi hình dạng so với golden signature — cần rà soát nguồn. */
export class DchartSchemaError extends Error {}

/** Lỗi mạng/HTTP sau khi retry hết lượt. */
export class DchartNetworkError extends Error {}

let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * GET /dchart/history — OHLCV EOD đã adjust. Retry 5xx/timeout 2 lần với
 * backoff 1s → 4s; 4xx khác throw SchemaError ngay (không retry mù).
 */
export async function fetchDchartHistory(p: {
  symbol: string;
  fromUnixSec: number;
  toUnixSec: number;
  timeoutMs?: number;
}): Promise<FetchHistoryResult> {
  const url =
    `${DCHART_BASE}/dchart/history?symbol=${encodeURIComponent(p.symbol)}` +
    `&resolution=D&from=${Math.floor(p.fromUnixSec)}&to=${Math.floor(p.toUnixSec)}`;

  let attempt = 0;
  for (;;) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(p.timeoutMs ?? 20_000),
        headers: { accept: "text/plain, application/json" },
      });
    } catch (err) {
      if (attempt >= 2) {
        throw new DchartNetworkError(
          `dchart timeout/mạng sau ${attempt + 1} lần thử: ${String(err)}`
        );
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      attempt++;
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      if (!text || !text.trim()) return { empty: true }; // mã không có dữ liệu
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(text) as Record<string, unknown>;
      } catch {
        if (/not support resolution/i.test(text)) {
          throw new DchartConfigError(`dchart chối resolution D: ${text.slice(0, 120)}`);
        }
        throw new DchartSchemaError(`dchart 200 nhưng body không phải JSON: ${text.slice(0, 120)}`);
      }
      const { t, o, h, l, c, v, s } = obj as Record<string, unknown>;
      const arrays = { t, o, h, l, c, v };
      for (const [k, val] of Object.entries(arrays)) {
        if (!Array.isArray(val)) {
          throw new DchartSchemaError(`[${p.symbol}] thiếu mảng '${k}' — schema drift`);
        }
      }
      const len = (t as unknown[]).length;
      if (len === 0) return { empty: true };
      for (const [k, val] of Object.entries(arrays)) {
        if ((val as unknown[]).length !== len) {
          throw new DchartSchemaError(`[${p.symbol}] mảng '${k}' lệch độ dài`);
        }
      }
      if (s !== "ok") {
        throw new DchartSchemaError(`[${p.symbol}] s='${String(s)}' ≠ 'ok'`);
      }
      return {
        empty: false,
        bars: {
          t: t as number[],
          o: o as number[],
          h: h as number[],
          l: l as number[],
          c: c as number[],
          v: v as number[],
        },
      };
    }
    if (res.status >= 500 || res.status === 429) {
      if (attempt >= 2) {
        throw new DchartNetworkError(`dchart HTTP ${res.status} sau ${attempt + 1} lần thử`);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      attempt++;
      continue;
    }
    // 4xx khác — khả năng endpoint đã đổi: KHÔNG retry
    const body = await res.text().catch(() => "");
    throw new DchartSchemaError(`dchart HTTP ${res.status} bất thường: ${body.slice(0, 160)}`);
  }
}

function round100(v: number): number {
  return Math.round(v / 100) * 100;
}

/**
 * Chuyển mảng dchart → RealBarInput đã validate §5.
 * Trả về { bars, skipped } — bar vi phạm nặng bị bỏ + đếm (minh bạch).
 */
export function toRealBars(symbol: string, h: DchartHistory): { bars: RealBarInput[]; skipped: number } {
  const bars: RealBarInput[] = [];
  let skipped = 0;
  const nowMs = Date.now();
  const seenDates = new Set<string>();

  for (let i = 0; i < h.t.length; i++) {
    const tSec = h.t[i];
    if (!Number.isFinite(tSec) || tSec <= 0) {
      skipped++;
      continue;
    }
    const d = new Date(tSec * 1000);
    // Q6/Q7: ngày giao dịch UTC — bỏ T7/CN và ngày tương lai
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) {
      skipped++;
      continue;
    }
    if (d.getTime() > nowMs) {
      skipped++;
      continue;
    }

    // Giá dchart = nghìn VND → VND, làm tròn bội 100 (Q1)
    const open = round100(h.o[i] * 1000);
    const high = round100(h.h[i] * 1000);
    const low = round100(h.l[i] * 1000);
    const close = round100(h.c[i] * 1000);
    const volume = Math.max(0, Math.round(h.v[i] ?? 0)); // Q3

    if (
      close < PRICE_MIN_VND ||
      close > PRICE_MAX_VND ||
      open < PRICE_MIN_VND ||
      open > PRICE_MAX_VND
    ) {
      skipped++;
      continue;
    }

    // OHLC sanity: high = max(h,o,c), low = min(l,o,c) khi nguồn lệch nhẹ
    const fixedHigh = Math.max(high, open, close);
    const fixedLow = Math.min(low, open, close);

    // Bar.date = 15:00 UTC của ngày giao dịch (convention tick route EOD rollover)
    const date = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 15, 0, 0)
    );
    const dateKey = date.toISOString().slice(0, 10);
    if (seenDates.has(dateKey)) {
      skipped++; // duplicate trong response — giữ bản cuối (đã push sau)
      continue;
    }
    seenDates.add(dateKey);

    bars.push({
      date,
      open,
      high: fixedHigh,
      low: fixedLow,
      close,
      volume,
      value: BigInt(Math.max(0, volume)) * BigInt(close),
    });
  }
  void symbol;
  return { bars, skipped };
}

/** Neo Quote vào EOD thật từ 2 bar cuối (ref = close bar trước, OHLC = bar cuối). */
async function anchorQuoteToRealEod(
  instrumentId: string,
  bars: RealBarInput[]
): Promise<void> {
  if (bars.length === 0) return;
  const last = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
  const ref = prev ? prev.close : last.close;

  const ceiling = round100(Math.min(ref * 1.07, 1_000_000_000));
  const floor = Math.max(100, round100(ref * 0.93));
  const change = last.close - ref;
  const changePct = ref > 0 ? Number(((change / ref) * 100).toFixed(2)) : 0;
  const spread = Math.max(100, round100(last.close * 0.001));
  // Depth ~1% KLGD phiên chia 2 bên (giá trị hiển thị, đơn vị lô 100 cp)
  const depthLots = Math.max(10, Math.min(500, Math.round(last.volume / 100 / 100)));
  // tradedAt = giờ đóng cửa 15:00 ICT (08:00 UTC) của phiên cuối
  const tradedAt = new Date(
    Date.UTC(
      last.date.getUTCFullYear(),
      last.date.getUTCMonth(),
      last.date.getUTCDate(),
      8,
      0,
      0
    )
  );

  const existing = await db.quote.findFirst({
    where: { instrumentId },
    select: { id: true },
  });
  const data = {
    open: last.open,
    high: last.high,
    low: last.low,
    last: last.close,
    close: last.close,
    volume: last.volume,
    refPrice: ref,
    ceilingPrice: ceiling,
    floorPrice: floor,
    change,
    changePct,
    bidPrice: Math.max(floor, last.close - spread),
    askPrice: Math.min(ceiling, last.close + spread),
    bidVolume: depthLots * 100,
    askVolume: depthLots * 100,
    tradedAt,
  };
  if (existing) {
    await db.quote.update({ where: { id: existing.id }, data });
  } else {
    await db.quote.create({ data: { instrumentId, ...data } });
  }
}

export interface EodSyncOutcome {
  ok: boolean;
  symbolsOk: string[];
  symbolsEmpty: string[];
  symbolsFailed: { symbol: string; error: string }[];
  barsUpserted: number;
  barsSkipped: number;
  lastTradeDate: string | null;
  durationMs: number;
  error?: string;
}

/**
 * Đồng bộ EOD cho toàn bộ instrument đang hoạt động (mặc định lookback 10 ngày
 * — đủ che T7/CN/lễ). Upsert từng bar (Q4 idempotent) + neo Quote + đánh dấu
 * DataSourceStatus key "eod-history" mode "real".
 */
export async function syncEodFromDchart(opts?: {
  lookbackDays?: number;
}): Promise<EodSyncOutcome> {
  const startedAt = Date.now();
  const lookbackDays = Math.max(2, Math.min(3650, opts?.lookbackDays ?? 10));
  const toSec = Math.floor(Date.now() / 1000) + 86_400; // +1 ngày chặn biên
  const fromSec = toSec - lookbackDays * 86_400;

  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    select: { id: true, symbol: true },
    orderBy: { symbol: "asc" },
    take: MAX_SYMBOLS_PER_SYNC,
  });

  const symbolsOk: string[] = [];
  const symbolsEmpty: string[] = [];
  const symbolsFailed: { symbol: string; error: string }[] = [];
  let barsUpserted = 0;
  let barsSkipped = 0;
  let lastTradeDate: string | null = null;

  for (const inst of instruments) {
    try {
      const res = await fetchDchartHistory({
        symbol: inst.symbol,
        fromUnixSec: fromSec,
        toUnixSec: toSec,
      });
      if (res.empty) {
        symbolsEmpty.push(inst.symbol);
        continue;
      }
      const { bars, skipped } = toRealBars(inst.symbol, res.bars);
      barsSkipped += skipped;
      if (bars.length === 0) {
        symbolsEmpty.push(inst.symbol);
        continue;
      }
      for (const b of bars) {
        await db.bar.upsert({
          where: { instrumentId_date: { instrumentId: inst.id, date: b.date } },
          create: {
            instrumentId: inst.id,
            date: b.date,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            value: b.value,
          },
          update: {
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            value: b.value,
          },
        });
      }
      barsUpserted += bars.length;
      await anchorQuoteToRealEod(inst.id, bars);
      symbolsOk.push(inst.symbol);
      const d = bars[bars.length - 1].date.toISOString().slice(0, 10);
      if (d > (lastTradeDate ?? "")) lastTradeDate = d;
    } catch (err) {
      symbolsFailed.push({
        symbol: inst.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const outcome: EodSyncOutcome = {
    ok: symbolsOk.length > 0 && symbolsFailed.length < instruments.length,
    symbolsOk,
    symbolsEmpty,
    symbolsFailed,
    barsUpserted,
    barsSkipped,
    lastTradeDate,
    durationMs: Date.now() - startedAt,
  };

  await markSource("eod-history", {
    mode: "real",
    success: outcome.ok,
    meta: {
      source: "dchart-api.vndirect.com.vn",
      provider: "VNDIRECT (public EOD)",
      symbolsOk: symbolsOk.length,
      symbolsEmpty: symbolsEmpty.length,
      symbolsFailed: symbolsFailed.length,
      barsUpserted,
      barsSkipped,
      lastTradeDate,
      lookbackDays,
      note:
        "Bar EOD thật (đã adjust) từ dchart VNDIRECT — Tier 1 DATA_SOURCES §3.1",
    },
  });

  return outcome;
}

/**
 * Deep backfill toàn bộ lịch sử (mặc định từ 2013-01-01) — xoá bar synthetic
 * của từng instrument rồi createMany bar thật theo chunk, neo Quote vào EOD
 * cuối. Chỉ chạy qua script prisma/import-real-eod.ts hoặc API force=deep.
 */
export async function deepBackfillEod(opts?: { fromYear?: number }): Promise<EodSyncOutcome> {
  const startedAt = Date.now();
  const fromYear = opts?.fromYear ?? 2013;
  const fromSec = Math.floor(Date.UTC(fromYear, 0, 1) / 1000);
  const toSec = Math.floor(Date.now() / 1000) + 86_400;

  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    select: { id: true, symbol: true },
    orderBy: { symbol: "asc" },
    take: MAX_SYMBOLS_PER_SYNC,
  });

  const symbolsOk: string[] = [];
  const symbolsEmpty: string[] = [];
  const symbolsFailed: { symbol: string; error: string }[] = [];
  let barsUpserted = 0;
  let barsSkipped = 0;
  let lastTradeDate: string | null = null;

  for (const inst of instruments) {
    try {
      const res = await fetchDchartHistory({
        symbol: inst.symbol,
        fromUnixSec: fromSec,
        toUnixSec: toSec,
        timeoutMs: 30_000,
      });
      if (res.empty) {
        symbolsEmpty.push(inst.symbol);
        continue;
      }
      const { bars, skipped } = toRealBars(inst.symbol, res.bars);
      barsSkipped += skipped;
      if (bars.length === 0) {
        symbolsEmpty.push(inst.symbol);
        continue;
      }
      // Thay toàn bộ lịch sử synthetic bằng bar thật (idempotent khi chạy lại)
      await db.bar.deleteMany({ where: { instrumentId: inst.id } });
      for (let i = 0; i < bars.length; i += 1000) {
        const chunk = bars.slice(i, i + 1000);
        await db.bar.createMany({
          data: chunk.map((b) => ({
            instrumentId: inst.id,
            date: b.date,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            value: b.value,
          })),
        });
      }
      barsUpserted += bars.length;
      await anchorQuoteToRealEod(inst.id, bars);
      symbolsOk.push(inst.symbol);
      const d = bars[bars.length - 1].date.toISOString().slice(0, 10);
      if (d > (lastTradeDate ?? "")) lastTradeDate = d;
    } catch (err) {
      symbolsFailed.push({
        symbol: inst.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const outcome: EodSyncOutcome = {
    ok: symbolsOk.length > 0,
    symbolsOk,
    symbolsEmpty,
    symbolsFailed,
    barsUpserted,
    barsSkipped,
    lastTradeDate,
    durationMs: Date.now() - startedAt,
  };

  await markSource("eod-history", {
    mode: "real",
    success: outcome.ok,
    meta: {
      source: "dchart-api.vndirect.com.vn",
      provider: "VNDIRECT (public EOD)",
      deepBackfill: true,
      fromYear,
      symbolsOk: symbolsOk.length,
      symbolsEmpty: symbolsEmpty.length,
      symbolsFailed: symbolsFailed.length,
      barsUpserted,
      barsSkipped,
      lastTradeDate,
      note: "Deep backfill 2013→nay — bar EOD thật (đã adjust) từ dchart VNDIRECT",
    },
  });

  return outcome;
}
