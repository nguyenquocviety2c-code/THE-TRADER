/**
 * src/lib/vn-calendar.ts — P2-4 LỊCH GIAO DỊCH CHÍNH THỨC VN + OVERLAY
 * RUNTIME (phiên #62). DATA_PLATFORM_BLUEPRINT v1.6 §5 P2-4: "Lịch giao
 * dịch chính thức ngày lễ VN (hiện suy từ union Bar)".
 *
 * Kiến trúc 2 lớp (giữ market-session.ts thuần sync/client-safe cho UI):
 *   · LỚP TĨNH — market-session.ts VN_HOLIDAYS_OFFICIAL (2026 chính thức +
 *     2027 ước lượng): nguồn sự thật ngày lễ đã biết trước.
 *   · LỚP RUNTIME (file này, server-only) — overlay AppSetting
 *     "vn-holidays": { extra: ["YYYY-MM-DD"], remove: ["YYYY-MM-DD"] } cho
 *     ngày lễ ĐỘT XUẤT (quốc tang, nghỉ bù thông báo muộn…) — cập nhật qua
 *     PUT /api/settings { vnHolidays } KHÔNG cần deploy.
 *
 * Người tiêu thụ chính: A9 data-quality (ictNow → isOfficialTradingDay —
 * freshness "ngoài ngày giao dịch" + eodCheckDue "cả sàn thiếu hôm nay" hết
 * false-SEVERE khi cả sàn nghỉ lễ chưa nằm ở lớp tĩnh) · GET
 * /api/market/calendar · UI Cài đặt (CalendarCard).
 *
 * Cache in-process 60s (đọc mỗi phép kiểm A9 + chu kỳ) — invalidate khi
 * save overlay.
 */

import { db } from "@/lib/db";
import { VN_HOLIDAYS_OFFICIAL, isTradingDay } from "@/lib/market-session";

const KEY_VN_HOLIDAYS = "vn-holidays";
const OVERLAY_CACHE_TTL_MS = 60_000;

export interface VnHolidayOverlay {
  /** Ngày nghỉ THÊM (lớp tĩnh chưa có — vd quốc tang, nghỉ bù muộn). */
  extra: string[];
  /** Ngày lớp tĩnh coi là lễ nhưng thực tế VẪN giao dịch (bỏ khỏi lịch). */
  remove: string[];
}

const EMPTY_OVERLAY: VnHolidayOverlay = { extra: [], remove: [] };

function isValidIsoDate(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())
  );
}

/** Chuẩn hoá payload overlay (bỏ ngày sai định dạng, dedupe, sort). */
function normalizeOverlay(raw: {
  extra?: unknown;
  remove?: unknown;
}): VnHolidayOverlay {
  const extra = Array.isArray(raw.extra)
    ? [...new Set(raw.extra.filter(isValidIsoDate))].sort()
    : [];
  const remove = Array.isArray(raw.remove)
    ? [...new Set(raw.remove.filter(isValidIsoDate))].sort()
    : [];
  return { extra, remove };
}

/* ── Cache overlay (60s) ────────────────────────────────────────────── */

let overlayCache: { value: VnHolidayOverlay; expiresAt: number } | null = null;

/** Đọc overlay runtime — AppSetting "vn-holidays" (60s, fail-safe rỗng). */
export async function getVnHolidayOverlay(): Promise<VnHolidayOverlay> {
  const now = Date.now();
  if (overlayCache && overlayCache.expiresAt > now) return overlayCache.value;
  let value = EMPTY_OVERLAY;
  try {
    const row = await db.appSetting.findUnique({ where: { key: KEY_VN_HOLIDAYS } });
    if (row) {
      const parsed = JSON.parse(row.value) as { extra?: unknown; remove?: unknown };
      value = normalizeOverlay(parsed);
    }
  } catch (err) {
    console.error("[vn-calendar] đọc overlay AppSetting lỗi (dùng rỗng):", err);
  }
  overlayCache = { value, expiresAt: now + OVERLAY_CACHE_TTL_MS };
  return value;
}

/** Lưu overlay (PUT /api/settings { vnHolidays }) — invalidate cache. */
export async function saveVnHolidayOverlay(
  patch: { extra?: unknown; remove?: unknown }
): Promise<VnHolidayOverlay> {
  const cur = await getVnHolidayOverlay();
  // Patch semantics: truyền mảng thì thay; omit thì giữ (đồng bộ settings.ts)
  const next = normalizeOverlay({
    extra: patch.extra !== undefined ? patch.extra : cur.extra,
    remove: patch.remove !== undefined ? patch.remove : cur.remove,
  });
  await db.appSetting.upsert({
    where: { key: KEY_VN_HOLIDAYS },
    create: { key: KEY_VN_HOLIDAYS, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  overlayCache = null; // invalidate
  return next;
}

/* ── Lịch chính thức hiệu lực ───────────────────────────────────────── */

let mergedCache: { value: Set<string>; overlayKey: string; expiresAt: number } | null = null;

/** Set ngày lễ hiệu lực = tĩnh ∪ extra − remove (cache 60s theo overlay). */
async function effectiveHolidaySet(): Promise<Set<string>> {
  const overlay = await getVnHolidayOverlay();
  const now = Date.now();
  const overlayKey = JSON.stringify(overlay);
  if (
    mergedCache &&
    mergedCache.overlayKey === overlayKey &&
    mergedCache.expiresAt > now
  ) {
    return mergedCache.value;
  }
  const set = new Set(VN_HOLIDAYS_OFFICIAL.map((h) => h.date));
  for (const d of overlay.extra) set.add(d);
  for (const d of overlay.remove) set.delete(d);
  mergedCache = { value: set, overlayKey, expiresAt: now + OVERLAY_CACHE_TTL_MS };
  return set;
}

/** Ngày VN của thời điểm (cùng quy ước vnShift — dịch +7h lấy phần UTC). */
function vnIsoOf(date: Date): string {
  return new Date(date.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Ngày giao dịch CHÍNH THỨC (async — tĩnh + overlay runtime). Đây là
 * isTradingDay của A9/eod-check: cả sàn nghỉ lễ chưa biết trước (overlay
 * extra) → không còn báo "outage tổng?" giả.
 */
export async function isOfficialTradingDay(date: Date): Promise<boolean> {
  const iso = vnIsoOf(date);
  const holidays = await effectiveHolidaySet();
  if (holidays.has(iso)) return false;
  // Thứ 7/CN theo giờ VN (logic ngày trong tuần của market-session.ts)
  const v = new Date(date.getTime() + 7 * 3_600_000);
  const dow = v.getUTCDay();
  return dow !== 0 && dow !== 6;
}

/* ── Khung nhìn lịch cho API/UI ─────────────────────────────────────── */

export interface CalendarDay {
  date: string;
  trading: boolean;
  holidayName: string | null;
  /** "static" (lớp tĩnh) | "overlay-extra" | "overlay-removed". */
  source: "static" | "overlay-extra" | "overlay-removed" | "weekend" | "trading";
}

/**
 * Khung nhìn lịch [from, to] (ISO date) — dùng bởi GET /api/market/calendar
 * và UI Cài đặt. weekend vẫn đánh dấu riêng (nguồn sự thật cuối tuần của
 * market-session.ts).
 */
export async function officialCalendarView(
  fromIso: string,
  toIso: string
): Promise<{ days: CalendarDay[]; overlay: VnHolidayOverlay }> {
  const overlay = await getVnHolidayOverlay();
  const staticByName = new Map(VN_HOLIDAYS_OFFICIAL.map((h) => [h.date, h.name]));
  const days: CalendarDay[] = [];
  const start = new Date(`${fromIso}T00:00:00Z`).getTime();
  const end = new Date(`${toIso}T00:00:00Z`).getTime();
  for (let t = start; t <= end && days.length < 400; t += 86_400_000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const dow = new Date(t).getUTCDay();
    const extra = overlay.extra.includes(iso);
    const removed = overlay.remove.includes(iso);
    const staticHoliday = staticByName.get(iso);
    const weekend = dow === 0 || dow === 6;
    let trading: boolean;
    let source: CalendarDay["source"];
    let holidayName: string | null = null;
    if (extra) {
      trading = false;
      source = "overlay-extra";
      holidayName = staticHoliday ?? "nghỉ (khai báo runtime)";
    } else if (removed && staticHoliday) {
      trading = !weekend;
      source = "overlay-removed";
      holidayName = `${staticHoliday} (đã bỏ khỏi lịch)`;
    } else if (staticHoliday) {
      trading = false;
      source = "static";
      holidayName = staticHoliday;
    } else if (weekend) {
      trading = false;
      source = "weekend";
    } else {
      trading = true;
      source = "trading";
    }
    days.push({ date: iso, trading, holidayName, source });
  }
  return { days, overlay };
}

/** Ngày lễ sắp tới (hiển thị UI) — từ hôm nay theo lịch hiệu lực. */
export async function upcomingHolidays(limit = 6): Promise<
  { date: string; name: string; source: "static" | "overlay-extra" }[]
> {
  const overlay = await getVnHolidayOverlay();
  const todayIso = vnIsoOf(new Date());
  const staticByName = new Map(VN_HOLIDAYS_OFFICIAL.map((h) => [h.date, h.name]));
  return [
    ...VN_HOLIDAYS_OFFICIAL.map((h) => ({ date: h.date, name: h.name, source: "static" as const })),
    ...overlay.extra
      .filter((d) => !staticByName.has(d))
      .map((d) => ({ date: d, name: "nghỉ (khai báo runtime)", source: "overlay-extra" as const })),
  ]
    .filter((h) => h.date >= todayIso && !overlay.remove.includes(h.date))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, limit);
}

export { isTradingDay };
