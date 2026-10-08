/**
 * src/lib/data-quality.ts — HỢP ĐỒNG CHẤT LƯỢNG DỮ LIỆU `DataQualityVerdict` (P0-4).
 * DATA_PLATFORM_BLUEPRINT v1.1 §3.2 + §5 P0-4 + ma trận ngưỡng (review #56).
 *
 * 6 PHÉP KIỂM (§1.2 A9 — Kiểm định viên chuỗi dữ liệu):
 *   (i)   freshness — per-symbol THEO LỊCH PHIÊN SÀN; 3 trạng thái tách bạch
 *         THIẾU (không có dòng Quote — US/HK) / ĐÓNG CỬA (ngoài phiên, nghỉ
 *         trưa, ATC, cuối tuần — KHÔNG complaining) / CŨ BẤT THƯỜNG (trong
 *         phiên liên tục mà quote tuổi > 2'). Quote-freshness dùng TRONG phiên,
 *         Bar-freshness (nến mới nhất so hôm nay sau 16:15 ICT) dùng NGOÀI
 *         phiên — hết "crying wolf" tối & cuối tuần (§0.2).
 *   (ii)  gap — per-market: lịch giao dịch sàn = union ngày bar của toàn mã
 *         active CÙNG SÀN, quorum ≥ 50% (rổ xoay không làm lịch lung lay; không
 *         gộp liên sàn — tránh gap GIẢ ngày lễ VN khi Mỹ vẫn giao dịch) + phép
 *         kiểm riêng "cả sàn thiếu hôm nay sau sync".
 *   (iii) outlier 2 LỚP — cấu trúc (OHLC chéo · giá ≤ 0 · volume < 0 · biến
 *         động close/prev vượt DẢI GIỚI HẠN SÀN: 7% HOSE · 10% HNX · 15% UPCOM
 *         — chuyển động thật không thể vượt, vượt là artefact) làm ISSUE;
 *         Hampel |r−med| > 3·1,4826·MAD cửa sổ 20 (trailing, không lookahead)
 *         chỉ INFO — ngày trần/sàn VN là biến động THẬT; ≥ 5 cờ/mã mới lên issue.
 *   (iv)  split-nghi-vấn — CHỈ VN: điều kiện tiên quyết gap open[t]/close[t−1]
 *         VƯỢT dải giới hạn sàn + volume ≥ 3× ADTV corroborate → cảnh báo
 *         (luôn DEGRADED-kèm, KHÔNG bao giờ SEVERE một mình). US/HK không
 *         gap-infer (crash −50%/ngày có thật — review #56).
 *   (v)   source — đọc DataSourceStatus (7 nguồn) so mode kỳ vọng;
 *         eod-history chính nó fail → SEVERE.
 *   (vi)  readiness — A9 TỰ TÍNH qua FeatureContract (cùng thư viện với S2 →
 *         cùng số, không phụ thuộc thứ tự trong đợt A — §3.3).
 *
 * Ma trận ngưỡng PASS/DEGRADED/SEVERE: bảng trong §5 (review #56) — đọc được
 * từ AppSetting "data-quality-thresholds" (tránh magic-number đóng băng).
 *
 * A9 KHÔNG bao giờ đụng VETO (của A6/A7/A8 — §3.3): DEGRADED → cờ vào prompt
 * Wave B + Chủ tịch; SEVERE → RiskAlert bắt buộc ack. KHÔNG hard-stop (8-1b).
 *
 * Verdict P0 lưu trong AgentRun.output của A9 (0 đổi schema — review #56);
 * model DataQualityReport nâng cấp P1-7 khi cần lịch sử dài.
 *
 * Thuần TypeScript — 0 dependency mới (kỷ luật §6).
 */

import { db } from "@/lib/db";
import { isTradingDay } from "@/lib/market-session";
import { topByAdtv } from "@/lib/dated-series";
import { latestFeatureSnapshot } from "@/lib/ml/features";

/* ═══════════════════════ Kiểu hợp đồng ═══════════════════════ */

export type DqLevel = "PASS" | "DEGRADED" | "SEVERE";

export type DqCheckKind =
  | "freshness"
  | "gap"
  | "outlier"
  | "split"
  | "source"
  | "readiness";

/** Một phép kiểm trong verdict. */
export interface DqCheck {
  kind: DqCheckKind;
  level: DqLevel;
  /** Câu tiếng Việt ngắn (dùng cho prompt + digest S1). */
  detail: string;
  /** Phạm vi: "market:HOSE" · "symbol:VCB" · "source:intl-eod"… */
  scope?: string;
}

/** Số liệu tổng hợp — đầu vào cho prompt khối TÍNH TRẠNG DỮ LIỆU + S0/S1. */
export interface DqSummary {
  /** Số mã VN active (HOSE/HNX/UPCOM). */
  vnActive: number;
  /** Mã VN có dòng Quote. */
  vnQuoted: number;
  /** Mã VN CŨ BẤT THƯỜNG trong phiên (quote tuổi > ngưỡng). */
  vnStaleInSession: number;
  /** Mã active KHÔNG có dòng Quote (US/HK theo thiết kế finfo). */
  missingQuote: number;
  /** Mã active 0 bar (backlog — vd US/HK chờ Yahoo 429). */
  zeroBarSymbols: string[];
  /** Mã US/HK có bar nhưng nến cũ > 5 ngày lịch. */
  intlStaleBars: string[];
  /** EOD hôm nay thiếu (sau 16:15 ICT ngày giao dịch) — đếm mã VN có bar. */
  eodMissingToday: number;
  /** Số mã có vi phạm outlier (cấu trúc + dải + Hampel ≥ 5 cờ). */
  outlierSymbols: number;
  /** Tổng cờ Hampel INFO (chưa lên issue). */
  hampelFlags: number;
  /** Mã nghi-vấn split (VN, gap vượt dải + volume ≥ 3× ADTV). */
  splitSuspects: string[];
  /** Trạng thái 7 nguồn. */
  sources: { key: string; mode: string; expected: string; ok: boolean; lastError: string | null }[];
  /** Readiness rổ đặc trưng topByAdtv(10). */
  readinessReady: number;
  readinessTotal: number;
  readinessMissing: string[];
  /** F-591-02: các query DB lỗi trong lần kiểm định này (rỗng = đọc đủ) —
   *  khi không rỗng, mọi số liệu tổng hợp khác CHẠY TRÊN DỮ LIỆU RỖNG và
   *  prompt phải nói rõ thay vì mô tả như "thị trường sạch". */
  dbFail: string[];
}

/** JSON chuẩn lưu AgentRun.output của A9 mỗi chu kỳ (hợp đồng §3.2). */
export interface DataQualityVerdict {
  asOf: string;
  level: DqLevel;
  checks: DqCheck[];
  summary: DqSummary;
}

/* ═══════════════════════ Hằng số phiên theo sàn ═══════════════════════ */

/** Lịch phiên theo SÀN (phút ICT) — P0-4 "VERIFY khi triển khai".
 *  Nguồn sự thật duy nhất cho giờ đóng cửa: market-session.ts (HOSE) + bảng
 *  này cho HNX/UPCOM (mạch mưu thuẫn footer "09:15–15:00" vs tick dừng
 *  14:44:59 ở §0.2 — 14:45 là giờ vào ATC, quote ngừng cập nhật là ĐÚNG). */
interface MarketWindow {
  open1: number;
  close1: number;
  open2: number;
  close2: number;
  /** Dải giá giới hạn ± (0,07/0,10/0,15) — dùng cho outlier band + split. */
  band: number;
}

const MARKET_WINDOWS: Record<string, MarketWindow> = {
  // HOSE: liên tục 09:15–11:30 · 13:00–14:45 (ATC 14:45–15:00); cổ phiếu ±7%
  HOSE: { open1: 555, close1: 690, open2: 780, close2: 885, band: 0.07 },
  // HNX: liên tục 09:30–11:30 · 13:30–15:00; ±10%
  HNX: { open1: 570, close1: 690, open2: 810, close2: 900, band: 0.1 },
  // UPCOM: liên tục 09:00–11:30 · 13:00–15:00; ±15%
  UPCOM: { open1: 540, close1: 690, open2: 780, close2: 900, band: 0.15 },
};

/** Các sàn VN (corporate-events P1-1 tái dùng — auto-adjust CHỈ VN). */
export const VN_MARKETS = new Set(["HOSE", "HNX", "UPCOM"]);

/** Dải giá theo (market, type) — ETF HOSE ±10% (quy định hiện hành).
 *  P1-1 (#60): xuất public cho corporate-events.ts (cùng công thức dải +
 *  biên tick — tránh 2 nguồn sự thật lệch nhau). */
export function priceBand(market: string, type: string): number | null {
  if (!VN_MARKETS.has(market)) return null; // US/HK: crash thật — không band
  if (type === "INDEX" || type === "FUND") return null; // chỉ số/quỹ mở: không band
  if (type === "ETF" && market === "HOSE") return 0.1;
  return MARKET_WINDOWS[market]?.band ?? null;
}

/** Bước giá VN = 100 ₫ (HOSE/HNX/UPCOM cho phạm vi giá thông thường). */
const VN_TICK = 100;

/**
 * Close vượt TRẦN/SÀN hợp lệ của sàn hay không — tính theo công thức sàn:
 * ceiling = ceil(ref×(1+band)/tick)×tick · floor = floor(ref×(1−band)/tick)×tick
 * + trượt 1 tick (ref ≠ close hôm trước hiếm khi lệch > 1 tick sau điều chỉnh).
 * Chỉ dùng close_hôm_trước làm xấp xỉ ref — nghiem thu thực tế 2026-10-08:
 * TCB 31.300→33.500 = 7,03% là ngày trần THẬT (tick làm tròn lên), lọc >7%
 * cứng sẽ crying wolf mỗi ngày trần/sàn — phải trừ đúng biên tick.
 */
export function beyondBand(close: number, prevClose: number, band: number): boolean {
  if (!(prevClose > 0) || !(close > 0)) return false;
  const ceiling = Math.ceil((prevClose * (1 + band)) / VN_TICK) * VN_TICK + VN_TICK;
  const floor = Math.floor((prevClose * (1 - band)) / VN_TICK) * VN_TICK - VN_TICK;
  return close > ceiling || close < floor;
}

/** Trong phiên liên tục của sàn? (đã qua isTradingDay ở caller). */
function inContinuousSession(market: string, minutesIct: number): boolean {
  const w = MARKET_WINDOWS[market];
  if (!w) return false;
  return (
    (minutesIct >= w.open1 && minutesIct <= w.close1) ||
    (minutesIct >= w.open2 && minutesIct <= w.close2)
  );
}

/** Giờ ICT "đã qua EOD-sync trễ" — 16:15 (ma trận: "sau 16:15 ICT"). */
const EOD_CHECK_MINUTES = 16 * 60 + 15;
/** Quote trong phiên coi CŨ khi tuổi > 2' (tick 10s; chịu 1 lần recompile). */
const QUOTE_STALE_SEC = 120;
/** Cửa sổ outlier/split theo ngày lịch (≈ 60 phiên = 1 QUÝ — Hampel ≥ 5 cờ
 *  /mã/quý mới lên issue, đúng chữ blueprint; trước đây 90 phiên làm ngưỡng
 *  5 cờ dễ hơn 1,5× → false-issue trên thị trường biến động). */
const OUTLIER_CALENDAR_DAYS = 92;
/** Cờ Hampel INFO ≥ mốc này /mã → tính là 1 issue. */
const HAMPEL_ISSUE_MIN = 5;
/** Bar US/HK cũ hơn mốc ngày lịch này → ghi chú stale. */
const INTL_STALE_DAYS = 5;
/** Quorum lịch giao dịch per-market (union ngày bar). */
const CALENDAR_QUORUM = 0.5;

/* ═══════════════════════ Ngưỡng (AppSetting) ═══════════════════════ */

/** Ma trận ngưỡng mặc định — §5 P0-4 (review #56), chỉnh qua AppSetting. */
export interface DqThresholds {
  /** % mã VN CŨ trong phiên → DEGRADED. */
  staleDegradedPct: number;
  /** % mã VN CŨ trong phiên → SEVERE. */
  staleSeverePct: number;
  /** % mã thiếu EOD hôm nay sau 16:15 → SEVERE (freshness). */
  eodMissingSeverePct: number;
  /** Số ngày GD của sàn thiếu liên tục → DEGRADED (1 mã). */
  gapDegradedDays: number;
  /** % mã active của sàn thiếu hôm nay → SEVERE. */
  gapSevereTodayPct: number;
  /** Số mã có thanh vi phạm → DEGRADED (1–4). */
  outlierDegradedSymbols: number;
  /** Số mã có thanh vi phạm → SEVERE (≥ 5 — mẫu hình nguồn hỏng). */
  outlierSevereSymbols: number;
  /** % rổ đủ đặc trưng < mốc → DEGRADED. */
  readinessDegradedPct: number;
  /** % rổ đủ đặc trưng < mốc → SEVERE. */
  readinessSeverePct: number;
}

const DEFAULT_THRESHOLDS: DqThresholds = {
  staleDegradedPct: 25,
  staleSeverePct: 60,
  eodMissingSeverePct: 50,
  gapDegradedDays: 2,
  gapSevereTodayPct: 10,
  outlierDegradedSymbols: 1,
  outlierSevereSymbols: 5,
  readinessDegradedPct: 80,
  readinessSeverePct: 50,
};

/** Đọc ngưỡng — AppSetting "data-quality-thresholds" phủ mặc định. */
async function getThresholds(): Promise<DqThresholds> {
  const row = await db.appSetting
    .findUnique({ where: { key: "data-quality-thresholds" } })
    .catch(() => null);
  if (!row) return DEFAULT_THRESHOLDS;
  try {
    const parsed = JSON.parse(row.value) as Partial<DqThresholds>;
    return { ...DEFAULT_THRESHOLDS, ...parsed };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

/* ═══════════════════════ Tiện ích số học ═══════════════════════ */

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Hampel trailing cửa sổ 20: flag khi |r_t − med| > 3·1,4826·MAD (không lookahead). */
function hampelFlagCount(rets: number[], window = 20): number {
  let flags = 0;
  for (let t = window; t < rets.length; t++) {
    const w = rets.slice(t - window, t);
    const med = median(w);
    const mad = median(w.map((x) => Math.abs(x - med)));
    if (mad <= 0) continue; // cửa sổ phẳng — không scale robust được
    if (Math.abs(rets[t] - med) > 3 * 1.4826 * mad) flags++;
  }
  return flags;
}

/* ═══════════════ Scan outlier thuần (P1-6 — dùng chung route ∥ chu kỳ) ═══════════════ */

/** Bar input cho scan outlier thuần (cấu trúc DB tối giản). */
export interface ScanBarInput {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  value: bigint | null;
}

/** Kết quả scan outlier 1 mã (cấu trúc + dải + Hampel + split-nghi-vấn). */
export interface SymbolOutlierScan {
  structural: number;
  bandViolations: number;
  hampelFlags: number;
  hampelIssue: boolean;
  splitSuspect: boolean;
  adtv: number;
}

/**
 * Scan outlier 2 lớp + split-nghi-vấn cho 1 mã — HÀM THUẦN (P1-6 #60:
 * blueprint §4.2 "A9-check là hàm thuần gọi được cả từ route (runtime) lẫn
 * từ runDataIntegrity (chu kỳ)"). runDataQualityChecks và ingest-pipeline
 * CÙNG gọi đây — một định nghĩa, không rẽ nhánh. Thuật toán giữ nguyên từng
 * dấu với P0-4/#59 (regression: verdict không đổi). US/HK: band=null →
 * chỉ kiểm cấu trúc (crash thật không bị bắt là outlier).
 */
export function scanOutlierBars(market: string, type: string, bars: ScanBarInput[]): SymbolOutlierScan {
  const band = priceBand(market, type);
  let structural = 0;
  let bandViolations = 0;
  let splitSuspect = false;
  const rets: number[] = [];
  let adtvSum = 0;
  let adtvCount = 0;
  const tail45 = bars.slice(-45);
  for (const b of tail45) {
    const v = b.value != null ? Number(b.value) : b.close * b.volume;
    if (v > 0) {
      adtvSum += v;
      adtvCount++;
    }
  }
  const adtv = adtvCount > 0 ? adtvSum / adtvCount : 0;
  let prevClose: number | null = null;
  for (const b of bars) {
    if (!(b.close > 0)) {
      structural++; // giá ≤ 0 — artefact dữ liệu
      continue;
    }
    if (b.high < b.low || b.open <= 0 || b.high <= 0 || b.low <= 0 || b.volume < 0) {
      structural++;
    }
    if (prevClose != null && prevClose > 0) {
      rets.push(Math.log(b.close / prevClose));
      if (band != null) {
        if (beyondBand(b.close, prevClose, band)) bandViolations++;
        // (iv) split-nghi-vấn: gap open/prevClose VƯỢT dải (cùng biên tick)
        // + volume ≥ 3× ADTV corroborate
        if (
          b.open > 0 &&
          beyondBand(b.open, prevClose, band) &&
          adtv > 0 &&
          b.close * b.volume >= 3 * adtv
        ) {
          splitSuspect = true;
        }
      }
    } else {
      rets.push(0);
    }
    prevClose = b.close;
  }
  const hampelFlags = hampelFlagCount(rets);
  return {
    structural,
    bandViolations,
    hampelFlags,
    hampelIssue: hampelFlags >= HAMPEL_ISSUE_MIN,
    splitSuspect,
    adtv,
  };
}

/* ═══════════════════════ 6 phép kiểm ═══════════════════════ */

/** Thời gian ICT hiện tại (cùng quy ước market-session.ts / market-engine). */
function ictNow(): { date: string; minutes: number; tradingDay: boolean } {
  const v = new Date(Date.now() + 7 * 3_600_000);
  return {
    date: v.toISOString().slice(0, 10),
    minutes: v.getUTCHours() * 60 + v.getUTCMinutes(),
    tradingDay: isTradingDay(new Date()),
  };
}

/**
 * Chạy toàn bộ 6 phép kiểm → DataQualityVerdict. Deterministic, đọc DB,
 * không ném lỗi ra ngoài (thiếu dữ liệu → kiểm đó PASS với ghi chú trung thực).
 *
 * Fixbug #59 F-591-02: TRƯỚC ĐÂY mọi query lỗi bị `.catch(() => [])` nuốt
 * im lặng → DB chết hoàn toàn cũng cho verdict PASS (kiểm định viên mù khi
 * chính mắt bị bịt). Giờ query lỗi được ghi vào `dbFail` → verdict SEVERE
 * kèm phép kiểm nguồn mô tả rõ — prompt Wave B + Chủ tịch + RiskAlert đều
 * nhận cờ đúng sự thật.
 */
export async function runDataQualityChecks(): Promise<DataQualityVerdict> {
  const asOf = new Date();
  const ict = ictNow();
  const thresholds = await getThresholds();
  const checks: DqCheck[] = [];
  const dbFail: string[] = [];
  /** Đánh dấu query lỗi (phân biệt "DB không đọc được" với "chưa có dữ liệu
   *  hợp lệ") — fallback như cũ nhưng verdict sẽ lên SEVERE. */
  const guard = <T>(p: Promise<T>, label: string, fallback: T): Promise<T> =>
    p.catch((err) => {
      dbFail.push(`${label} (${err instanceof Error ? err.message.slice(0, 60) : String(err).slice(0, 60)})`);
      return fallback;
    });

  /* ── Nạp dữ liệu nền (3 query song song) ─────────────────────────── */
  const [instruments, quoteRows, barMaxGroup] = await Promise.all([
    guard(
      db.instrument.findMany({
        where: { isActive: true },
        select: { id: true, symbol: true, market: true, type: true },
      }),
      "instrument",
      [] as { id: string; symbol: string; market: string; type: string }[]
    ),
    guard(
      db.quote.findMany({ select: { instrumentId: true, tradedAt: true } }),
      "quote",
      [] as { instrumentId: string; tradedAt: Date }[] // Quote update-in-place: 1 dòng/mã
    ),
    guard(
      db.bar.groupBy({ by: ["instrumentId"], _max: { date: true } }),
      "bar-max",
      [] as { instrumentId: string; _max: { date: Date | null } }[]
    ),
  ]);

  const byId = new Map(instruments.map((i) => [i.id, i]));
  const quoteAt = new Map(quoteRows.map((q) => [q.instrumentId, q.tradedAt]));
  const lastBarAt = new Map<string, Date>();
  for (const g of barMaxGroup) {
    if (g._max.date) lastBarAt.set(g.instrumentId, g._max.date);
  }

  const vnSymbols = instruments.filter((i) => VN_MARKETS.has(i.market));
  const intlSymbols = instruments.filter((i) => i.market === "US" || i.market === "HK");
  const zeroBarSymbols = instruments
    .filter((i) => !lastBarAt.has(i.id))
    .map((i) => i.symbol);
  const missingQuote = instruments.filter((i) => !quoteAt.has(i.id)).length;

  /* ── (i) FRESHNESS — per-symbol theo lịch phiên sàn ──────────────── */
  let vnQuoted = 0;
  let vnStaleInSession = 0;
  const staleNames: string[] = [];
  for (const i of vnSymbols) {
    const q = quoteAt.get(i.id);
    if (!q) continue; // THIẾU — đếm ở missingQuote
    vnQuoted++;
    if (!ict.tradingDay) continue; // ĐÓNG CỬA (cuối tuần/lễ) — không complaining
    if (!inContinuousSession(i.market, ict.minutes)) continue; // pre-open/lunch/ATC/sau đóng
    const ageSec = Math.max(0, (Date.now() - q.getTime()) / 1000);
    if (ageSec > QUOTE_STALE_SEC) {
      vnStaleInSession++;
      if (staleNames.length < 8) staleNames.push(i.symbol);
    }
  }
  // Bar-freshness (NGOÀI phiên): sau 16:15 ICT ngày giao dịch, nến mới nhất
  // phải là hôm nay — dùng cho cả proxy "EOD hôm nay thiếu"
  const eodCheckDue = ict.tradingDay && ict.minutes >= EOD_CHECK_MINUTES;
  let eodMissingToday = 0;
  const vnWithBars = vnSymbols.filter((i) => lastBarAt.has(i.id));
  for (const i of vnWithBars) {
    if (eodCheckDue && lastBarAt.get(i.id)!.toISOString().slice(0, 10) < ict.date) {
      eodMissingToday++;
    }
  }
  // US/HK: không có Quote (THIẾU — theo thiết kế finfo VN-only); bar cũ > 5 ngày
  const intlStaleBars: string[] = [];
  for (const i of intlSymbols) {
    const last = lastBarAt.get(i.id);
    if (last && Date.now() - last.getTime() > INTL_STALE_DAYS * 86_400_000) {
      intlStaleBars.push(i.symbol);
    }
  }

  {
    const stalePct = vnQuoted > 0 ? (vnStaleInSession / vnQuoted) * 100 : 0;
    const eodPct = vnWithBars.length > 0 ? (eodMissingToday / vnWithBars.length) * 100 : 0;
    let level: DqLevel = "PASS";
    if (stalePct >= thresholds.staleSeverePct) level = "SEVERE";
    else if (stalePct >= thresholds.staleDegradedPct) level = "DEGRADED";
    if (eodCheckDue && eodPct >= thresholds.eodMissingSeverePct) level = "SEVERE";
    const bits = [
      `${vnQuoted}/${vnSymbols.length} mã VN có báo giá${missingQuote > 0 ? ` · ${missingQuote} mã thiếu dòng Quote (US/HK — finfo chỉ phục vụ VN)` : ""}`,
      ict.tradingDay
        ? inContinuousSessionAny(ict.minutes)
          ? `${vnStaleInSession} mã cũ bất thường trong phiên${staleNames.length ? ` (${staleNames.join(", ")})` : ""}`
          : "ngoài phiên liên tục — quote đứng ở mức đóng là ĐÚNG (không báo cũ)"
        : "ngoài ngày giao dịch — không kiểm tuổi quote (hết crying wolf)",
      eodCheckDue
        ? `EOD ${ict.date}: ${vnWithBars.length - eodMissingToday}/${vnWithBars.length} mã có nến hôm nay`
        : "EOD hôm nay chưa đến giờ kiểm (16:15 ICT)",
      intlStaleBars.length > 0
        ? `${intlStaleBars.length} mã US/HK có nến cũ > ${INTL_STALE_DAYS} ngày (${intlStaleBars.slice(0, 5).join(", ")})`
        : intlSymbols.length > 0
          ? `nến US/HK trong hạn ${INTL_STALE_DAYS} ngày`
          : "",
      zeroBarSymbols.length > 0
        ? `${zeroBarSymbols.length} mã 0 nến (backlog: ${zeroBarSymbols.slice(0, 6).join(", ")}${zeroBarSymbols.length > 6 ? "…" : ""})`
        : "",
    ].filter(Boolean);
    checks.push({ kind: "freshness", level, detail: bits.join(" · ") });
  }

  /* ── Nạp cửa sổ bar VN cho gap + outlier + split (1 query) ───────── */
  const vnIds = vnSymbols.map((i) => i.id);
  const outlierCutoff = new Date(Date.now() - OUTLIER_CALENDAR_DAYS * 86_400_000);
  type WindowBarRow = {
    instrumentId: string;
    date: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    value: bigint | null;
  };
  const windowBars: WindowBarRow[] = vnIds.length
    ? await guard(
        db.bar.findMany({
          where: { instrumentId: { in: vnIds }, date: { gte: outlierCutoff } },
          orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
          select: {
            instrumentId: true,
            date: true,
            open: true,
            high: true,
            low: true,
            close: true,
            volume: true,
            value: true,
          },
        }),
        "bar-window",
        [] as WindowBarRow[]
      )
    : [];
  const barsByInstrument = new Map<string, typeof windowBars>();
  for (const b of windowBars) {
    const list = barsByInstrument.get(b.instrumentId) ?? [];
    list.push(b);
    barsByInstrument.set(b.instrumentId, list);
  }

  /* ── (ii) GAP — per-market, union-calendar quorum ≥ 50% ──────────── */
  {
    let gapDegraded = false;
    const gapBits: string[] = [];
    let marketsMissingToday = 0;
    for (const market of VN_MARKETS) {
      const members = vnSymbols.filter((i) => i.market === market);
      const withBars = members.filter((i) => barsByInstrument.has(i.id));
      if (withBars.length === 0) continue;
      // Union lịch: ngày có bar ở ≥ 50% số mã (có bar trong cửa sổ) của sàn
      const dateCount = new Map<string, number>();
      for (const i of withBars) {
        for (const b of barsByInstrument.get(i.id)!) {
          const iso = b.date.toISOString().slice(0, 10);
          dateCount.set(iso, (dateCount.get(iso) ?? 0) + 1);
        }
      }
      const quorum = Math.ceil(withBars.length * CALENDAR_QUORUM);
      const calendar = [...dateCount.entries()]
        .filter(([, c]) => c >= quorum)
        .map(([d]) => d)
        .sort();
      if (calendar.length === 0) continue;
      // Mã thiếu ≥ gapDegradedDays ngày giao dịch của sàn (sau bar đầu tiên
      // của chính mã trong cửa sổ — mã mới listing không bị trượt điểm)
      const shortNames: string[] = [];
      for (const i of withBars) {
        const own = new Set(
          barsByInstrument.get(i.id)!.map((b) => b.date.toISOString().slice(0, 10))
        );
        const first = own.values().next().value as string | undefined;
        if (first == null) continue;
        let missing = 0;
        for (const d of calendar) {
          if (d >= first && !own.has(d)) missing++;
        }
        if (missing >= thresholds.gapDegradedDays) shortNames.push(i.symbol);
      }
      if (shortNames.length > 0) {
        gapDegraded = true;
        gapBits.push(
          `${market}: ${shortNames.length} mã thiếu ≥ ${thresholds.gapDegradedDays} phiên của sàn (${shortNames.slice(0, 5).join(", ")}${shortNames.length > 5 ? "…" : ""})`
        );
      }
      // Phép kiểm riêng "cả sàn thiếu hôm nay sau sync" (outage tổng)
      if (eodCheckDue) {
        const todayIso = ict.date;
        const haveToday = withBars.filter((i) =>
          barsByInstrument
            .get(i.id)!
            .some((b) => b.date.toISOString().slice(0, 10) === todayIso)
        ).length;
        const missingPct = ((withBars.length - haveToday) / withBars.length) * 100;
        if (missingPct >= thresholds.gapSevereTodayPct) {
          marketsMissingToday++;
          gapBits.push(
            `${market}: ${Math.round(missingPct)}% mã active thiếu nến hôm nay sau sync (outage tổng?)`
          );
        }
      }
    }
    checks.push({
      kind: "gap",
      level: marketsMissingToday > 0 ? "SEVERE" : gapDegraded ? "DEGRADED" : "PASS",
      detail:
        gapBits.length > 0
          ? gapBits.join(" · ")
          : "0 mã thiếu ≥ 2 phiên giao dịch của sàn (cửa sổ 90 phiên · quorum lịch 50%)",
    });
  }

  /* ── (iii)+(iv) OUTLIER 2 lớp + SPLIT-nghi-vấn (chỉ VN) ──────────── */
  let outlierSymbols = 0;
  let hampelFlags = 0;
  const splitSuspects: string[] = [];
  const outlierBits: string[] = [];
  {
    for (const [instrumentId, bars] of barsByInstrument) {
      const inst = byId.get(instrumentId);
      if (!inst) continue;
      const band = priceBand(inst.market, inst.type);
      const scan = scanOutlierBars(inst.market, inst.type, bars);
      hampelFlags += scan.hampelFlags;
      if (scan.splitSuspect) splitSuspects.push(inst.symbol);
      if (scan.structural > 0 || scan.bandViolations > 0 || scan.hampelIssue) {
        outlierSymbols++;
        if (outlierBits.length < 5) {
          outlierBits.push(
            `${inst.symbol}: ${scan.structural > 0 ? `${scan.structural} thanh cấu trúc` : ""}${scan.bandViolations > 0 ? `${scan.structural > 0 ? " · " : ""}${scan.bandViolations} thanh vượt dải ±${band != null ? Math.round(band * 100) : "?"}%` : ""}${scan.hampelIssue ? `${scan.structural > 0 || scan.bandViolations > 0 ? " · " : ""}${scan.hampelFlags} cờ Hampel` : ""}`
          );
        }
      }
    }
    let level: DqLevel = "PASS";
    if (outlierSymbols >= thresholds.outlierSevereSymbols) level = "SEVERE";
    else if (outlierSymbols >= thresholds.outlierDegradedSymbols) level = "DEGRADED";
    checks.push({
      kind: "outlier",
      level,
      detail:
        outlierBits.length > 0
          ? `${outlierSymbols} mã có thanh vi phạm — ${outlierBits.join(" · ")} · ${hampelFlags} cờ Hampel INFO (ngày trần/sàn thật không lên issue)`
          : `0 thanh vi phạm cấu trúc/dải · ${hampelFlags} cờ Hampel INFO (cửa sổ 90 phiên)`,
    });
    // Split: 1 nghi vấn mới → DEGRADED "luôn kèm"; KHÔNG bao giờ SEVERE một mình
    checks.push({
      kind: "split",
      level: splitSuspects.length > 0 ? "DEGRADED" : "PASS",
      detail:
        splitSuspects.length > 0
          ? `${splitSuspects.length} mã nghi-vấn split (VN: gap open/prevClose vượt dải sàn + volume ≥ 3× ADTV — P1-1 pipeline TỰ ĐIỀU CHỈNH khi khớp heuristic mức CAO ±1% cả 2 phép; còn trong verdict = chưa khớp hoặc kill-switch tắt — xem CorporateEvent SUSPECTED): ${splitSuspects.join(", ")}`
          : "0 nghi-vấn split (điều kiện: VN + gap vượt dải sàn + volume ≥ 3× ADTV)",
    });
  }

  /* ── (v) SOURCE — 7 dòng DataSourceStatus so mode kỳ vọng ────────── */
  const sources: DqSummary["sources"] = [];
  {
    const EXPECTED: Record<string, string[]> = {
      "eod-history": ["real"],
      "market-quotes": ["real"],
      news: ["live"],
      "foreign-flows": ["simulated", "live"],
      "intl-eod": ["real"],
      fundamentals: ["real"],
      trading: ["paper"],
    };
    const rows = await guard(
      db.dataSourceStatus.findMany(),
      "dataSourceStatus",
      [] as { key: string; mode: string; lastError: string | null }[]
    );
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const mismatched: string[] = [];
    let eodFail = false;
    for (const [key, expected] of Object.entries(EXPECTED)) {
      const row = byKey.get(key);
      if (!row) {
        sources.push({ key, mode: "(chưa khởi tạo)", expected: expected.join("|"), ok: true, lastError: null });
        continue; // chưa chạy route lần nào — INFO, không degraded
      }
      const ok = expected.includes(row.mode);
      sources.push({
        key,
        mode: row.mode,
        expected: expected.join("|"),
        ok,
        lastError: row.lastError ?? null,
      });
      if (!ok) mismatched.push(`${key}=${row.mode}${row.lastError ? ` (${row.lastError.slice(0, 60)})` : ""}`);
      if (key === "eod-history" && !ok) eodFail = true;
    }
    checks.push({
      kind: "source",
      level: eodFail ? "SEVERE" : mismatched.length > 0 ? "DEGRADED" : "PASS",
      detail:
        mismatched.length > 0
          ? `${mismatched.length}/${Object.keys(EXPECTED).length} nguồn lệch mode kỳ vọng — ${mismatched.join(" · ")}`
          : `${sources.length} nguồn đều đúng mode khai báo`,
    });
  }

  /* ── (vi) READINESS — A9 tự tính qua FeatureContract (§3.3) ──────── */
  const readinessMissing: string[] = [];
  let readinessReady = 0;
  let readinessTotal = 0;
  {
    // F-612R-02/#61 (Vòng 2): rổ topByAdtv giờ qua guard() — query lỗi vào
    // dbFail → verdict SEVERE (trước đây .catch(() => []) cho rỗ trống →
    // readiness 0/0 = PASS GIẢ khi đúng query rổ chết — F-591-02 trở lại
    // qua đường dated-series mà #59 chưa phủ).
    const basket = await guard(
      topByAdtv(10, { market: "HOSE", type: "STOCK" }),
      "readiness.rổ topByAdtv",
      [] as Awaited<ReturnType<typeof topByAdtv>>
    );
    readinessTotal = basket.length;
    // Fixbug #59 F-591-03: take 65 → 70 — cùng độ sâu nạp với S2
    // (runFeatureStore) để "cùng thư viện → CÙNG SỐ" là đúng từng chữ: chuỗi
    // 65 bar và 70 bar cho RSI14/MACD khác nhau ở chữ số cuối (Wilder/EMA
    // đệ quy chưa hội tụ tuyệt đối) → A9 và S2 có thể khác nhau ở biên ready.
    const barLists = await Promise.all(
      basket.map((t) =>
        db.bar
          .findMany({
            where: { instrumentId: t.id },
            orderBy: { date: "desc" },
            take: 70,
            select: { close: true, volume: true },
          })
          .then((rows) => rows.filter((b) => b.close > 0).reverse())
          .catch(() => [] as { close: number; volume: number }[])
      )
    );
    basket.forEach((t, i) => {
      const rows = barLists[i];
      const snap = latestFeatureSnapshot(
        rows.map((b) => b.close),
        rows.map((b) => b.volume)
      );
      if (snap?.ready) readinessReady++;
      else readinessMissing.push(t.symbol);
    });
    const pct = readinessTotal > 0 ? (readinessReady / readinessTotal) * 100 : 0;
    let level: DqLevel = "PASS";
    if (readinessTotal > 0 && pct < thresholds.readinessSeverePct) level = "SEVERE";
    else if (readinessTotal > 0 && pct < thresholds.readinessDegradedPct) level = "DEGRADED";
    checks.push({
      kind: "readiness",
      level,
      detail:
        readinessTotal > 0
          ? `rổ topByAdtv(10): ${readinessReady}/${readinessTotal} mã đủ 6 nhóm đặc trưng (SMA20 · SMA50 · RSI14 · MACD hist · động lượng 5 phiên · KL/TL20)${readinessMissing.length > 0 ? ` — thiếu: ${readinessMissing.join(", ")}` : ""}`
          : "rổ topByAdtv trống (chưa có bar HOSE-STOCK ≥ 10 phiên)",
    });
  }

  /* ── F-591-02: DB lỗi → verdict SEVERE (không bao giờ PASS khi mắt mù) ── */
  if (dbFail.length > 0) {
    checks.unshift({
      kind: "source",
      level: "SEVERE",
      detail: `A9 KHÔNG đọc được DB — ${dbFail.length} query lỗi (${dbFail.slice(0, 3).join(" · ")}) — các phép kiểm còn lại chạy trên dữ liệu rỗng KHÔNG đáng tin; cần chạy lại chu kỳ khi DB hồi phục.`,
    });
  }

  /* ── Tổng hợp verdict ───────────────────────────────────────────── */
  const level: DqLevel = checks.some((c) => c.level === "SEVERE")
    ? "SEVERE"
    : checks.some((c) => c.level === "DEGRADED")
      ? "DEGRADED"
      : "PASS";

  return {
    asOf: asOf.toISOString(),
    level,
    checks,
    summary: {
      vnActive: vnSymbols.length,
      vnQuoted,
      vnStaleInSession,
      missingQuote,
      zeroBarSymbols,
      intlStaleBars,
      eodMissingToday,
      outlierSymbols,
      hampelFlags,
      splitSuspects,
      sources,
      readinessReady,
      readinessTotal,
      readinessMissing,
      dbFail,
    },
  };
}

/** Có bất kỳ sàn VN nào đang trong phiên liên tục không (chọn chữ cho detail). */
function inContinuousSessionAny(minutesIct: number): boolean {
  return [...VN_MARKETS].some((m) => inContinuousSession(m, minutesIct));
}

/* ═══════════════════════ Prompt block (§3.3 — Wave B + Chủ tịch) ═══════════════════════ */

/**
 * Khối prompt "TÍNH TRẠNG DỮ LIỆU" — tiêm vào prompt 4 agent nghiên cứu +
 * Chủ tịch khi verdict ≠ PASS (chốt 8-1b: DEGRADED → cờ; SEVERE → cờ + RiskAlert).
 * Gọn ~7 dòng — không phình token prompt (nghiệm thu P0-3).
 */
export function dataQualityPromptBlock(v: DataQualityVerdict): string {
  const s = v.summary;
  const levelVi =
    v.level === "SEVERE" ? "SEVERE — chất lượng dữ liệu xấu nghiêm trọng" : "DEGRADED — có giới hạn cần khai báo";
  // F-591-02 (hoàn chỉnh): khi DB đọc lỗi, summary chạy trên dữ liệu RỖNG —
  // các dòng mô tả chuẩn sẽ nói sai ("mọi mã đều có dữ liệu · tươi đúng lịch
  // phiên") → thay bằng khối ngắn nói thẳng A9 đang mù.
  if (s.dbFail && s.dbFail.length > 0) {
    return [
      `TÍNH TRẠNG DỮ LIỆU (A9 kiểm định ${new Date(v.asOf).toISOString().slice(0, 16).replace("T", " ")} UTC — ${levelVi}):`,
      `- A9 KHÔNG đọc được DB — ${s.dbFail.length} query lỗi (${s.dbFail.slice(0, 3).join(" · ")}).`,
      `- Số liệu tổng hợp chu kỳ này CHẠY TRÊN DỮ LIỆU RỖNG do lỗi đọc — "0 mã thiếu" KHÔNG có nghĩa thị trường sạch.`,
      "→ KHÔNG trích dẫn bất kỳ số liệu định lượng nào của chu kỳ này trong luận cứ; khai báo confound nghiêm trọng (kiểm định viên mù).",
    ].join("\n");
  }
  const lines = [
    `TÍNH TRẠNG DỮ LIỆU (A9 kiểm định ${new Date(v.asOf).toISOString().slice(0, 16).replace("T", " ")} UTC — ${levelVi}):`,
    `- Báo giá: ${s.vnQuoted}/${s.vnActive} mã VN có dòng quote${s.missingQuote > 0 ? ` · ${s.missingQuote} mã thiếu quote (US/HK)` : ""}${s.vnStaleInSession > 0 ? ` · ${s.vnStaleInSession} mã cũ bất thường trong phiên` : " · tươi đúng lịch phiên"}`,
    s.zeroBarSymbols.length > 0
      ? `- Nến 0 dòng: ${s.zeroBarSymbols.length} mã (${s.zeroBarSymbols.slice(0, 6).join(", ")}${s.zeroBarSymbols.length > 6 ? "…" : ""} — backlog)`
      : `- Nến: mọi mã active đều có dữ liệu`,
    s.eodMissingToday > 0
      ? `- EOD hôm nay thiếu ${s.eodMissingToday} mã VN (sau 16:15 ICT)`
      : "",
    s.splitSuspects.length > 0 ? `- Nghi-vấn split (chưa điều chỉnh): ${s.splitSuspects.join(", ")}` : "",
    (() => {
      const bad = s.sources.filter((x) => !x.ok);
      return bad.length > 0
        ? `- Nguồn lệch kỳ vọng: ${bad.map((x) => `${x.key}=${x.mode}`).join(" · ")}`
        : "";
    })(),
    `- Rổ đặc trưng sẵn sàng: ${s.readinessReady}/${s.readinessTotal} mã`,
    "→ Khi trích dẫn số liệu, khai báo độ confound dữ liệu (mã thiếu · nguồn fallback) trong luận cứ; KHÔNG bịa số cho mã thiếu.",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/* ═══════════════════════ RiskAlert khi SEVERE (8-1b) ═══════════════════════ */

/**
 * SEVERE ⇒ RiskAlert ack-bắt-buộc (một alert/phép kiểm, dedupe 24h theo code —
 * pattern risk/engine.ts). KHÔNG hard-stop chu kỳ (đã loại phương án (c)).
 */
export async function raiseSevereAlerts(v: DataQualityVerdict): Promise<number> {
  const severe = v.checks.filter((c) => c.level === "SEVERE");
  if (severe.length === 0) return 0;
  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const existing = await db.riskAlert
    .findMany({
      where: {
        code: { in: severe.map((c) => `DQ_${c.kind.toUpperCase()}`) },
        createdAt: { gte: since24h },
      },
      select: { id: true, code: true },
    })
    .catch(() => []);
  const seen = new Set(existing.map((e) => e.code));
  const fresh = severe.filter((c) => !seen.has(`DQ_${c.kind.toUpperCase()}`));
  if (fresh.length === 0) return 0;
  const created = await db.riskAlert
    .createMany({
      data: fresh.map((c) => ({
        severity: "CRITICAL" as const,
        code: `DQ_${c.kind.toUpperCase()}`,
        message: `[A9 P0-4] Kiểm định dữ liệu SEVERE — phép ${c.kind}: ${c.detail}. Agent nghiên cứu/chủ tịch đã nhận cờ trong prompt; trader cần ack và kiểm tra nguồn trước khi phê duyệt tín hiệu.`,
        metricKey: `data-quality.${c.kind}`,
      })),
    })
    .catch(() => ({ count: 0 }));
  return created.count;
}

/* ═══════════════════════ Trích verdict từ AgentRun.output ═══════════════════════ */

/** Đọc verdict từ output JSON của run A9 (runDataIntegrity lưu { verdict }). */
export function extractVerdict(output: unknown): DataQualityVerdict | null {
  if (!output || typeof output !== "object") return null;
  const v = (output as { verdict?: unknown }).verdict;
  if (!v || typeof v !== "object") return null;
  const cand = v as Partial<DataQualityVerdict>;
  if (
    (cand.level !== "PASS" && cand.level !== "DEGRADED" && cand.level !== "SEVERE") ||
    !Array.isArray(cand.checks) ||
    typeof cand.asOf !== "string" ||
    !cand.summary
  ) {
    return null;
  }
  return cand as DataQualityVerdict;
}
