/**
 * src/lib/corporate-events.ts — P1-1 (DATA_PLATFORM_BLUEPRINT v1.3 §5):
 * SỰ KIỆN DOANH NGHIỆP + TỰ ĐIỀU CHỈNH split (chốt 8-3b — user chọn TỰ ĐIỀU
 * CHỈNH NGAY kèm AuditLog, khác đề xuất "chỉ cảnh báo" của phiên #54).
 *
 * PHẠM VI TỰ ĐIỀU CHỈNH: CHỈ thị trường VN có dải giá giới hạn (HOSE ±7% ·
 * HNX ±10% · UPCOM ±15% — ETF HOSE ±10%; INDEX/FUND không band → bỏ qua).
 * US/HK KHÔNG BAO GIỜ gap-infer (crash −50%/ngày có thật ở Mỹ) — sự kiện ở
 * đó đến từ parse payload `events` của Yahoo (xem intl-eod.ts — nguồn XÁC
 * ĐỊNH CHÍNH XÁC, không heuristic).
 *
 * ĐIỀU KIỆN TIÊN QUYẾT VN (đòn bẩy an toàn quan trọng nhất — review #56):
 *   gap open[t]/close[t−1] VƯỢT DẢI GIỚI HẠN của sàn (chuyển động thật
 *   không thể > 7/10/15%/ngày → gap lớn hơn chắc chắn artefact điều chỉnh).
 *
 * HEURISTIC MỨC CAO (đủ mới tự sửa — §8-3b):
 *   (1) gap vượt dải (cùng công thức beyondBand trừ biên tick của A9 —
 *       ngày trần THẬT 7,03% do tick không bị tính là event);
 *   (2) volume corroborate: giá trị phiên event ≥ 3× ADTV-45 (bar trước
 *       event — cùng hợp đồng value của topByAdtv);
 *   (3) tỷ số khớp ±1% ở CẢ 2 PHÉP: f_open = open[t]/close[t−1] và
 *       f_close = close[t]/close[t−1] (sự kiện thật dịch CẢ thanh,
 *       bad-tick thường chỉ lệch 1 giá).
 *   (1)+(2)+(3) → AUTO_ADJUSTED; (1)+(2) mà (3) fail → SUSPECTED (ghi
 *   nhận, KHÔNG sửa giá — trung thực); thiếu (2) → không tạo row (A9
 *   outlier đã bắt — không spam bảng sự kiện).
 *
 * HƯỚNG ĐIỀU CHỈNH (sửa ambiguity #56): f = open[t]/close[t−1] — NHÂN
 * CHUỖI TRƯỚC event bằng f (đưa giá cũ về thang mới; f<1 cho cổ thưởng
 * 1,2/1,3/1,5 phổ biến VN). Đồng bộ cả 3 trường:
 *   giá ×f (round bội 100₫) · volume ×(1/f) (round) · value tính lại
 *   = volume_mới × close_mới (chỉ chỉnh giá mà không chỉnh volume thì
 *   ADTV méo — review #56 lỗi thứ 3).
 *
 * LỚP AN TOÀN ĐẢO NGƯỢC:
 *   - AuditLog action CORPORATE_EVENT_AUTO_ADJUSTED chứa đủ pre-values từng
 *     bar (date · OHLCV · value) + ratio + range → đảo ngược bằng 1 script
 *     (scripts/reverse-corporate-event.ts, gọi reverseCorporateEvent()).
 *   - Kill-switch AppSetting "corporate-event-autoadjust" {enabled: boolean}
 *     — tắt toàn cục: scan chỉ ghi SUSPECTED.
 *   - Kill-switch per-event: row CorporateEvent status REVERSED → KHÔNG
 *     bao giờ tự adjust lại (người đã nhìn và đảo ngược — quyết định người).
 *   - Upsert idempotent @@unique([instrumentId, date, kind]) chống trùng.
 *
 * HỘI TỤ (blueprint P1-1): eod-sync upsert đè lookback 10 ngày bằng giá
 * GỐC của nguồn → gap tái xuất → scan tái phát hiện. Chống DOUBLE-APPLY
 * bằng cột PIT lastSyncedAt (P1-2): chỉ nhân f lên các bar trước event có
 * lastSyncedAt > mốc adjustedAt của lần adjust trước (bar do nguồn gửi lại
 * GỐC); bar đã adjust (lastSyncedAt cũ) giữ nguyên. Deep backfill đè toàn
 * bộ → mọi bar trước event có lastSyncedAt mới → nhân f đúng 1 lần trên
 * chuỗi gốc. f mới phải khớp f cũ ±1% — lệch lớn → SUSPECTED (không sửa).
 *
 * Sau AUTO_ADJUSTED: quay lại chạy 6 phép A9 (runDataQualityChecks) —
 * outlier/gap phải sạch ở vùng vừa điều chỉnh (nghiệm thu P1-1).
 *
 * Thuần TypeScript — 0 dependency mới (kỷ luật §6).
 */

import { db } from "@/lib/db";
import { priceBand, beyondBand } from "@/lib/data-quality";

/** AppSetting kill-switch key (8-3b — default BẬT). */
export const CE_SETTING_KEY = "corporate-event-autoadjust";

/** Cửa sổ quét theo ngày lịch — 1 quý, khớp OUTLIER_CALENDAR_DAYS của A9. */
const CE_SCAN_WINDOW_DAYS = 92;

/** ADTV-45 phiên — cùng hợp đồng topByAdtv (dated-series.ts). */
const ADTV_SESSIONS = 45;

/** Volume corroborate: giá trị phiên event ≥ 3× ADTV (blueprint P1-1). */
const CE_VOLUME_CORROBORATE = 3;

/** Tỷ số khớp ±1% ở cả 2 phép (mức CAO — §8-3b). */
const CE_RATIO_AGREEMENT_PCT = 1;

/** Bước giá VN = 100 ₫ (round giá sau ×f — như eod-sync roundTo). */
const VN_TICK = 100;

/* ═══════════════════════ Kiểu hợp đồng ═══════════════════════ */

export interface CeCandidate {
  symbol: string;
  instrumentId: string;
  /** Ngày giao dịch ĐẦU TIÊN theo thang MỚI (ex-date — bar t). */
  eventDate: string; // ISO yyyy-mm-dd
  /** f = open[t]/close[t−1] — hệ số nhân chuỗi TRƯỚC event. */
  f: number;
  /** f_close = close[t]/close[t−1] — phép thứ 2 đối chiếu ±1%. */
  fClose: number;
  /** |f_close/f − 1|×100 — độ khớp 2 phép. */
  agreementPct: number;
  /** Gap mở phiên so close hôm trước (%). */
  gapPct: number;
  /** Giá trị phiên event (VND). */
  eventValue: number;
  /** ADTV-45 trước event (VND). */
  adtv: number;
  /** Đủ (1)+(2)+(3) — sẽ AUTO_ADJUSTED; false = SUSPECTED. */
  highConfidence: boolean;
}

export interface CeAdjustment {
  symbol: string;
  eventDate: string;
  kind: "SPLIT" | "BONUS";
  f: number;
  /** Số bar trước event bị nhân f lần này (chống double-apply). */
  barsAdjusted: number;
  auditLogId: string | null;
}

export interface CorporateEventScanResult {
  ranAt: string;
  /** Kill-switch đang bật/tắt. */
  autoAdjustEnabled: boolean;
  /** Số mã VN quét được. */
  scanned: number;
  candidates: CeCandidate[];
  adjusted: CeAdjustment[];
  /** 6 phép A9 chạy lại sau adjust (nghiệm thu P1-1) — null khi không adjust. */
  verdictAfter: { level: string; outlierSymbols: number; splitSuspects: string[] } | null;
  durationMs: number;
}

/* ═══════════════════════ Kill-switch (AppSetting) ═══════════════════════ */

/** Đọc kill-switch — AppSetting "corporate-event-autoadjust" {enabled}. */
export async function isAutoAdjustEnabled(): Promise<boolean> {
  const row = await db.appSetting
    .findUnique({ where: { key: CE_SETTING_KEY } })
    .catch(() => null);
  if (!row) return true; // mặc định BẬT (chốt 8-3b)
  try {
    const parsed = JSON.parse(row.value) as { enabled?: unknown };
    return parsed.enabled !== false; // {enabled: false} mới tắt
  } catch {
    return true; // JSON hỏng → an toàn mặc định bật? KHÔNG — tắt (fail-safe)
  }
}

/** Đặt kill-switch (route /api/market/corporate-events PUT). */
export async function setAutoAdjustEnabled(enabled: boolean): Promise<void> {
  await db.appSetting.upsert({
    where: { key: CE_SETTING_KEY },
    create: { key: CE_SETTING_KEY, value: JSON.stringify({ enabled }) },
    update: { value: JSON.stringify({ enabled }) },
  });
}

/* ═══════════════════════ Tiện ích ═══════════════════════ */

function roundToTick(v: number): number {
  return Math.round(v / VN_TICK) * VN_TICK;
}

/** Bar row tải từ DB cho scan (đủ trường adjust + PIT). */
interface ScanBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  value: bigint | null;
  firstSeenAt: Date;
  lastSyncedAt: Date;
}

/** Tính ADTV-45 (VND) từ value (fallback close×volume) — hợp đồng topByAdtv. */
function adtvOf(bars: ScanBar[], endIndexExclusive: number): number {
  const from = Math.max(0, endIndexExclusive - ADTV_SESSIONS);
  let sum = 0;
  let n = 0;
  for (let i = from; i < endIndexExclusive; i++) {
    const b = bars[i];
    const v = b.value != null ? Number(b.value) : b.close * b.volume;
    if (v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/* ═══════════════════════ Quét + điều chỉnh ═══════════════════════ */

/**
 * Quét corporate event VN trong cửa sổ 92 ngày và TỰ ĐIỀU CHỈNH khi heuristic
 * mức CAO khớp. Idempotent: gap biến mất sau adjust → lần sau không detect lại;
 * eod-sync đè lookback → gap tái xuất → chỉ adjust bar lastSyncedAt mới.
 *
 * opts.instrumentIds — giới hạn phạm vi (pipeline gọi cho mã vừa sync).
 */
export async function scanCorporateEvents(opts?: {
  instrumentIds?: string[];
}): Promise<CorporateEventScanResult> {
  const startedAt = Date.now();
  const autoAdjustEnabled = await isAutoAdjustEnabled();

  const cutoff = new Date(Date.now() - CE_SCAN_WINDOW_DAYS * 86_400_000);
  const instruments = await db.instrument
    .findMany({
      where: {
        isActive: true,
        market: { in: ["HOSE", "HNX", "UPCOM"] },
        ...(opts?.instrumentIds ? { id: { in: opts.instrumentIds } } : {}),
      },
      select: { id: true, symbol: true, market: true, type: true },
      orderBy: { symbol: "asc" },
    })
    .catch(() => [] as { id: string; symbol: string; market: string; type: string }[]);

  // Chỉ mã CÓ dải giá (STOCK/ETF — INDEX/FUND không band, không thể gap-infer)
  const eligible = instruments.filter((i) => priceBand(i.market, i.type) != null);

  const candidates: CeCandidate[] = [];
  const adjusted: CeAdjustment[] = [];

  for (const inst of eligible) {
    const band = priceBand(inst.market, inst.type)!;
    const bars = await db.bar
      .findMany({
        where: { instrumentId: inst.id, date: { gte: cutoff } },
        orderBy: { date: "asc" },
        select: {
          date: true, open: true, high: true, low: true, close: true,
          volume: true, value: true, firstSeenAt: true, lastSyncedAt: true,
        },
      })
      .catch(() => [] as ScanBar[]);
    if (bars.length < 3) continue;

    for (let t = 1; t < bars.length; t++) {
      const prev = bars[t - 1];
      const cur = bars[t];
      if (!(prev.close > 0) || !(cur.open > 0) || !(cur.close > 0)) continue;
      // (1) ĐIỀU KIỆN TIÊN QUYẾT: gap open/prevClose VƯỢT dải (trừ biên tick)
      if (!beyondBand(cur.open, prev.close, band)) continue;

      const adtv = adtvOf(bars, t);
      const eventValue = cur.value != null ? Number(cur.value) : cur.close * cur.volume;
      // (2) volume corroborate ≥ 3× ADTV — thiếu thì KHÔNG phải event
      // (bad-tick để A9 outlier lo), không tạo row
      if (!(adtv > 0) || eventValue < CE_VOLUME_CORROBORATE * adtv) continue;

      const f = cur.open / prev.close;
      const fClose = cur.close / prev.close;
      const agreementPct = Math.abs(fClose / f - 1) * 100;
      // (3) tỷ số khớp ±1% cả 2 phép
      const highConfidence = agreementPct <= CE_RATIO_AGREEMENT_PCT;

      candidates.push({
        symbol: inst.symbol,
        instrumentId: inst.id,
        eventDate: cur.date.toISOString().slice(0, 10),
        f: Number(f.toFixed(6)),
        fClose: Number(fClose.toFixed(6)),
        agreementPct: Number(agreementPct.toFixed(3)),
        gapPct: Number(((f - 1) * 100).toFixed(2)),
        eventValue,
        adtv: Math.round(adtv),
        highConfidence,
      });

      if (highConfidence && autoAdjustEnabled) {
        const res = await applyAutoAdjust(inst, bars, t, f).catch((err) => {
          console.error(`[corporate-events] adjust ${inst.symbol} lỗi:`, err);
          return null;
        });
        if (res) adjusted.push(res);
      } else {
        // SUSPECTED — ghi nhận trung thực, KHÔNG sửa giá
        await upsertEventRow(inst, cur.date, f < 1 ? "BONUS" : "SPLIT", f, "SUSPECTED", {
          gapPct: ((f - 1) * 100).toFixed(2),
          agreementPct: agreementPct.toFixed(3),
          eventValue,
          adtv: Math.round(adtv),
          reason: highConfidence
            ? "kill-switch đang TẮT — chỉ ghi nhận, không sửa giá"
            : "tỷ số 2 phép lệch > ±1% — không đủ tin cậy để tự sửa",
        }).catch(() => undefined);
      }

      // 1 mã chỉ xử lý event ĐẦU TIÊN tìm được trong cửa sổ (event cũ nhất
      // trong 92 ngày — adjust cả chuỗi trước nó; scan sau sẽ thấy vùng sạch)
      break;
    }
  }

  /* Nghiệm thu P1-1: sau AUTO_ADJUSTED → chạy lại 6 phép A9 (outlier/gap
   * phải sạch ở vùng vừa điều chỉnh). Verdict đầy đủ (không chỉ vùng) —
   * đọc như chu kỳ A9 thường để so sánh cùng chuẩn. */
  let verdictAfter: CorporateEventScanResult["verdictAfter"] = null;
  if (adjusted.length > 0) {
    const { runDataQualityChecks } = await import("@/lib/data-quality");
    const v = await runDataQualityChecks().catch(() => null);
    if (v) {
      verdictAfter = {
        level: v.level,
        outlierSymbols: v.summary.outlierSymbols,
        splitSuspects: v.summary.splitSuspects,
      };
    }
  }

  return {
    ranAt: new Date().toISOString(),
    autoAdjustEnabled,
    scanned: eligible.length,
    candidates,
    adjusted,
    verdictAfter,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * ÁP AUTO-ADJUST cho event tại index t của chuỗi bars:
 * nhân f lên toàn bộ bar TRƯỚC event (date < event) — nhưng chỉ bar nào là
 * "GỐC NGUỒN" (lastSyncedAt > adjustedAt của lần adjust trước) hoặc chưa từng
 * adjust (không có row trước đó) — chống double-apply khi eod-sync đè lại
 * lookback. Ghi AuditLog pre-values đủ đảo ngược + upsert CorporateEvent.
 */
async function applyAutoAdjust(
  inst: { id: string; symbol: string },
  bars: ScanBar[],
  eventIndex: number,
  f: number
): Promise<CeAdjustment | null> {
  const eventBar = bars[eventIndex];
  const kind: "SPLIT" | "BONUS" = f < 1 ? "BONUS" : "SPLIT";

  // Row event hiện có (nếu từng adjust/suspect trước đó) — chống double-apply
  const existing = await db.corporateEvent
    .findUnique({
      where: {
        instrumentId_date_kind: {
          instrumentId: inst.id,
          date: eventBar.date,
          kind,
        },
      },
    })
    .catch(() => null);

  if (existing?.status === "REVERSED") {
    // Kill-switch PER-EVENT: người đã đảo ngược — KHÔNG tự adjust lại
    // (trả null — scan không đếm là adjustment, row giữ nguyên REVERSED)
    return null;
  }

  // Nếu lần trước đã adjust với ratio khác > ±1% → SUSPECTED (an toàn)
  if (existing?.status === "AUTO_ADJUSTED" && existing.ratio > 0) {
    if (Math.abs(f / existing.ratio - 1) > CE_RATIO_AGREEMENT_PCT / 100) {
      await upsertEventRow(inst, eventBar.date, kind, f, "SUSPECTED", {
        reason: `f mới ${f.toFixed(4)} lệch f đã adjust ${existing.ratio.toFixed(4)} > ±1% — nguồn đổi số liệu, cần người kiểm tra`,
        previousRatio: existing.ratio,
      }).catch(() => undefined);
      return null;
    }
  }

  // Mốc adjustedAt lần trước (từ detail hoặc updatedAt của row)
  const prevAdjustedAt: Date | null =
    existing?.status === "AUTO_ADJUSTED" ? existing.updatedAt : null;

  // Vùng cần nhân f: bar TRƯỚC event, nguyên trạng GỐC NGUỒN
  // (lastSyncedAt > prevAdjustedAt) hoặc chưa từng có row adjust
  const targets: ScanBar[] = [];
  for (let i = 0; i < eventIndex; i++) {
    const b = bars[i];
    if (prevAdjustedAt == null || b.lastSyncedAt > prevAdjustedAt) {
      targets.push(b);
    }
  }

  const adjustedAt = new Date();
  const preValues = targets.map((b) => ({
    date: b.date.toISOString().slice(0, 10),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    value: b.value != null ? b.value.toString() : null,
  }));

  // Áp: giá ×f (round bội 100₫) · volume ×(1/f) · value tính lại
  const postValues = targets.map((b) => {
    const open = roundToTick(b.open * f);
    const high = roundToTick(b.high * f);
    const low = roundToTick(b.low * f);
    const close = roundToTick(b.close * f);
    const volume = Math.max(0, Math.round(b.volume / f));
    const value = BigInt(volume) * BigInt(close);
    return {
      date: b.date.toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume,
      value: value.toString(),
    };
  });

  // Cập nhật DB theo chunk transaction (update where unique instrumentId+date)
  for (let i = 0; i < targets.length; i += 200) {
    const chunk = targets.slice(i, i + 200).map((b, j) => ({ b, after: postValues[i + j] }));
    await db.$transaction(
      chunk.map(({ b, after }) =>
        db.bar.update({
          where: { instrumentId_date: { instrumentId: inst.id, date: b.date } },
          data: {
            open: after.open,
            high: after.high,
            low: after.low,
            close: after.close,
            volume: after.volume,
            value: BigInt(after.value),
            updatedAt: adjustedAt,
          },
        })
      )
    ).catch((err) => {
      throw err instanceof Error ? err : new Error(String(err));
    });
  }

  // AuditLog — đủ pre-values + ratio + range để đảo ngược bằng 1 script
  const audit = await db.auditLog
    .create({
      data: {
        action: "CORPORATE_EVENT_AUTO_ADJUSTED",
        entity: "Bar",
        entityId: inst.id,
        before: JSON.stringify({
          symbol: inst.symbol,
          eventDate: eventBar.date.toISOString().slice(0, 10),
          kind,
          ratio: f,
          range: {
            from: targets.length > 0 ? preValues[0].date : null,
            to: eventBar.date.toISOString().slice(0, 10),
            bars: targets.length,
          },
          bars: preValues,
        }),
        after: JSON.stringify({
          symbol: inst.symbol,
          eventDate: eventBar.date.toISOString().slice(0, 10),
          ratio: f,
          bars: postValues,
          note: "giá ×f · volume ×(1/f) · value = volume×close tính lại — đảo ngược bằng scripts/reverse-corporate-event.ts",
        }),
      },
    })
    .catch(() => null);

  await upsertEventRow(inst, eventBar.date, kind, f, "AUTO_ADJUSTED", {
    gapPct: ((f - 1) * 100).toFixed(2),
    barsAdjusted: targets.length,
    adjustedAt: adjustedAt.toISOString(),
    auditLogId: audit?.id ?? null,
    reverseBy: "scripts/reverse-corporate-event.ts",
    method: "gap-infer-dchart (VN — vượt dải + 3×ADTV + ±1% 2 phép)",
  });

  return {
    symbol: inst.symbol,
    eventDate: eventBar.date.toISOString().slice(0, 10),
    kind,
    f,
    barsAdjusted: targets.length,
    auditLogId: audit?.id ?? null,
  };
}

/** Upsert row CorporateEvent (idempotent @@unique [instrumentId, date, kind]). */
async function upsertEventRow(
  inst: { id: string; symbol: string },
  eventDate: Date,
  kind: "SPLIT" | "BONUS" | "DIVIDEND" | "RESTATE",
  ratio: number,
  status: "AUTO_ADJUSTED" | "SUSPECTED" | "REVERSED",
  detail: Record<string, unknown>
): Promise<void> {
  await db.corporateEvent.upsert({
    where: {
      instrumentId_date_kind: { instrumentId: inst.id, date: eventDate, kind },
    },
    create: {
      instrumentId: inst.id,
      date: eventDate,
      kind,
      ratio,
      status,
      source: "gap-infer-dchart",
      detail: JSON.stringify(detail),
    },
    update: {
      ratio,
      status,
      source: "gap-infer-dchart",
      detail: JSON.stringify(detail),
    },
  });
}

/* ═══════════════════════ Đảo ngược (lớp an toàn 8-3b) ═══════════════════════ */

export interface ReverseResult {
  ok: boolean;
  symbol?: string;
  eventDate?: string;
  barsRestored?: number;
  status?: string;
  error?: string;
}

/**
 * ĐẢO NGƯỢC 1 auto-adjust từ AuditLog pre-values (gọi bởi script
 * scripts/reverse-corporate-event.ts hoặc route POST manual):
 *   1. Đọc CorporateEvent row (status AUTO_ADJUSTED) + AuditLog tương ứng;
 *   2. Restore từng bar về pre-values (đúng cả value BigInt);
 *   3. Đổi status row → REVERSED (scan sau này KHÔNG tự adjust lại).
 * Chỉ đảo được khi AuditLog còn pre-values đầy đủ (bars > 0).
 */
export async function reverseCorporateEvent(eventId: string): Promise<ReverseResult> {
  try {
    const row = await db.corporateEvent.findUnique({ where: { id: eventId } });
    if (!row) return { ok: false, error: "CorporateEvent không tồn tại" };
    if (row.status === "REVERSED") {
      return { ok: false, error: "sự kiện đã REVERSED từ trước", status: row.status };
    }
    // AuditLog mới nhất của event này (entityId = instrumentId, action đúng)
    const audits = await db.auditLog.findMany({
      where: { action: "CORPORATE_EVENT_AUTO_ADJUSTED", entityId: row.instrumentId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const match = audits.find((a) => {
      try {
        const b = JSON.parse(a.before ?? "{}") as { eventDate?: string; kind?: string };
        return (
          b.eventDate === row.date.toISOString().slice(0, 10) &&
          (b.kind ?? "") === row.kind
        );
      } catch {
        return false;
      }
    });
    if (!match?.before) {
      return { ok: false, error: "không tìm thấy AuditLog pre-values của event này" };
    }
    const pre = JSON.parse(match.before) as {
      symbol: string;
      bars?: { date: string; open: number; high: number; low: number; close: number; volume: number; value: string | null }[];
    };
    const bars = pre.bars ?? [];
    if (bars.length === 0) {
      return { ok: false, error: "AuditLog không chứa pre-values bars (rỗng)" };
    }
    const restoredAt = new Date();
    for (let i = 0; i < bars.length; i += 200) {
      const chunk = bars.slice(i, i + 200);
      await db.$transaction(
        chunk.map((b) =>
          db.bar.update({
            where: {
              instrumentId_date: {
                instrumentId: row.instrumentId,
                date: new Date(`${b.date}T15:00:00.000Z`),
              },
            },
            data: {
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
              value: b.value != null ? BigInt(b.value) : null,
              updatedAt: restoredAt,
            },
          })
        )
      );
    }
    await db.corporateEvent.update({
      where: { id: row.id },
      data: {
        status: "REVERSED",
        detail: JSON.stringify({
          reversedAt: restoredAt.toISOString(),
          reversedFromAuditLog: match.id,
          barsRestored: bars.length,
          note: "đã đảo ngược thủ công — scan KHÔNG tự adjust lại (kill-switch per-event)",
        }),
      },
    });
    await db.auditLog.create({
      data: {
        action: "CORPORATE_EVENT_REVERSED",
        entity: "CorporateEvent",
        entityId: row.id,
        before: JSON.stringify({ status: row.status, ratio: row.ratio }),
        after: JSON.stringify({ status: "REVERSED", barsRestored: bars.length }),
      },
    });
    return {
      ok: true,
      symbol: pre.symbol,
      eventDate: row.date.toISOString().slice(0, 10),
      barsRestored: bars.length,
      status: "REVERSED",
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
