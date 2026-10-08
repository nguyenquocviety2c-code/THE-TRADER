/**
 * Lịch & phiên giao dịch VN (Q7/Q8 — DATA_SOURCES.md §5).
 * Timezone tính toán: Asia/Ho_Chi_Minh (UTC+7).
 *
 * P2-4 (phiên #62 — DATA_PLATFORM_BLUEPRINT §5): lịch nghỉ lễ Việt Nam
 * CHÍNH THỨC làm nguồn sự thật tĩnh (client-safe, sync — dùng cho UI + tick
 * + A9 fallback); phần overlay runtime (AppSetting "vn-holidays" — ngày lễ
 * đột xuất/tuỳ chỉnh không cần deploy) nằm ở src/lib/vn-calendar.ts phía
 * server và MERGE với danh sách này qua isOfficialTradingDay().
 */

/** Ngày VN "thật" của một thời điểm UTC (dịch +7h rồi lấy phần UTC). */
function vnShift(date: Date): Date {
  return new Date(date.getTime() + 7 * 3_600_000);
}

/** Ngày ISO (YYYY-MM-DD) theo Asia/Ho_Chi_Minh — ranh giới ngày luôn theo ICT (F-212). */
export function vnDateIso(date: Date = new Date()): string {
  return vnShift(date).toISOString().slice(0, 10);
}

export interface VnHoliday {
  date: string; // YYYY-MM-DD
  name: string;
  /** Ghi chú nguồn — "chính thức" = công bố đủ; "ước lượng" = chốt khi có công bố. */
  note?: string;
}

/**
 * Lịch nghỉ lễ Việt Nam CHÍNH THỨC (thị trường chứng khoán ngừng phiên —
 * khác ngày nghỉ cơ quan nhà nước khi có nghỉ bù cuối tuần).
 * Cập nhật hàng năm; 2027 là ƯỚC LƯỢNG theo quy luật công bố thường niên —
 * cập nhật khi Nhà nước/Sở công bố chính thức.
 */
export const VN_HOLIDAYS_OFFICIAL: VnHoliday[] = [
  // 2026 (fixbug #63 F-63C-01/F-63C-02 — đối chiếu công bố HOSE/HNX: Tết nghỉ
  // 5 phiên 16-20/02 (29 Tết → mùng 4); Quốc khánh nghỉ 31/8→2/9 do 2/9 rơi
  // thứ Tư, sở hoán đổi ngày làm việc T2 31/8, KHÔNG có phiên bù T7 22/8)
  { date: "2026-01-01", name: "Tết Dương lịch" },
  { date: "2026-02-16", name: "Tết Bính Ngọ (29 Tết)" },
  { date: "2026-02-17", name: "Tết Bính Ngọ (mùng 1)" },
  { date: "2026-02-18", name: "Tết Bính Ngọ (mùng 2)" },
  { date: "2026-02-19", name: "Tết Bính Ngọ (mùng 3)" },
  { date: "2026-02-20", name: "Tết Bính Ngọ (mùng 4)" },
  // F-110 (audit): Giỗ Tổ 10/3 âm = CN 26/04/2026 → thị trường nghỉ bù thứ Hai 27/04
  { date: "2026-04-27", name: "Giỗ Tổ Hùng Vương (nghỉ bù)" },
  { date: "2026-04-30", name: "Ngày Giải phóng miền Nam" },
  { date: "2026-05-01", name: "Ngày Quốc tế Lao động" },
  { date: "2026-08-31", name: "Quốc khánh (nghỉ hoán đổi)" },
  { date: "2026-09-01", name: "Quốc khánh (nghỉ liền)" },
  { date: "2026-09-02", name: "Quốc khánh" },
  // 2027 — ƯỚC LƯỢNG (Tết Đinh Mùi mùng 1 = 06/02/2027 Thứ Bảy; 02/09/2027
  // thứ Năm → KHÔNG nghỉ bù 03/09 — fixbug #63 F-63C-05)
  { date: "2027-01-01", name: "Tết Dương lịch", note: "ước lượng 2027" },
  { date: "2027-02-05", name: "Tết Đinh Mùi (30 Tết)", note: "ước lượng 2027" },
  { date: "2027-02-08", name: "Tết Đinh Mùi (mùng 3)", note: "ước lượng 2027" },
  { date: "2027-02-09", name: "Tết Đinh Mùi (mùng 4)", note: "ước lượng 2027" },
  { date: "2027-02-10", name: "Tết Đinh Mùi (mùng 5)", note: "ước lượng 2027" },
  { date: "2027-02-11", name: "Tết Đinh Mùi (mùng 6)", note: "ước lượng 2027" },
  { date: "2027-04-16", name: "Giỗ Tổ Hùng Vương (10/3 âm)", note: "ước lượng 2027" },
  { date: "2027-04-30", name: "Ngày Giải phóng miền Nam" },
  { date: "2027-05-03", name: "Ngày Quốc tế Lao động (nghỉ bù)", note: "ước lượng 2027" },
  { date: "2027-09-02", name: "Quốc khánh" },
];

/** Set tra cứu nhanh (sync — nội bộ module + isTradingDay). */
const VN_HOLIDAYS = new Set<string>(VN_HOLIDAYS_OFFICIAL.map((h) => h.date));

/** Tìm thông tin ngày lễ theo ISO date (tra cứu hiển thị). */
export function vnHolidayOf(iso: string): VnHoliday | undefined {
  return VN_HOLIDAYS_OFFICIAL.find((h) => h.date === iso);
}

// Biên phiên tính bằng GIÂY kể từ 00:00 ICT (F-111 — chính xác tới từng giây):
// 09:15:00=33300 · 11:30:00=41400 · 13:00:00=46800 · 14:45:00=53100 · 15:00:00=54000
const SEC_MORNING_OPEN = 9 * 3_600 + 15 * 60;
const SEC_MORNING_CLOSE = 11 * 3_600 + 30 * 60;
const SEC_PM_OPEN = 13 * 3_600;
const SEC_PM_CLOSE = 14 * 3_600 + 45 * 60;
const SEC_EOD = 15 * 3_600;

function vnSeconds(date: Date): number {
  const v = vnShift(date);
  return v.getUTCHours() * 3_600 + v.getUTCMinutes() * 60 + v.getUTCSeconds();
}

export function isTradingDay(date: Date): boolean {
  const v = vnShift(date);
  const dow = v.getUTCDay(); // 0 = CN, 6 = thứ 7
  if (dow === 0 || dow === 6) return false;
  const iso = v.toISOString().slice(0, 10);
  return !VN_HOLIDAYS.has(iso);
}

/** Phiên liên tục HOSE: 09:15–11:30 và 13:00–14:45 (ATC 14:45–15:00 tính riêng). */
export function isTradingSession(date: Date): boolean {
  if (!isTradingDay(date)) return false;
  const t = vnSeconds(date);
  return (
    (t >= SEC_MORNING_OPEN && t <= SEC_MORNING_CLOSE) ||
    (t >= SEC_PM_OPEN && t <= SEC_PM_CLOSE)
  );
}

export type SessionPhase =
  | "pre-open" // trước 09:15
  | "morning" // 09:15–11:30
  | "lunch" // 11:30–13:00
  | "afternoon" // 13:00–14:45
  | "atc" // 14:45–15:00
  | "closed"; // sau 15:00 hoặc ngoài ngày giao dịch

export function sessionPhase(date: Date): SessionPhase {
  if (!isTradingDay(date)) return "closed";
  const t = vnSeconds(date);
  if (t < SEC_MORNING_OPEN) return "pre-open";
  if (t <= SEC_MORNING_CLOSE) return "morning";
  if (t < SEC_PM_OPEN) return "lunch";
  if (t <= SEC_PM_CLOSE) return "afternoon";
  if (t <= SEC_EOD) return "atc";
  return "closed";
}

export const SESSION_PHASE_LABEL: Record<SessionPhase, string> = {
  "pre-open": "Trước phiên (ATO 09:00–09:15)",
  morning: "Liên tục sáng 09:15–11:30",
  lunch: "Nghỉ trưa 11:30–13:00",
  afternoon: "Liên tục chiều 13:00–14:45",
  atc: "ATC 14:45–15:00",
  closed: "Ngoài phiên",
};

/**
 * Có sinh tick giá mới không?
 * - MARKET_STRICT_SESSION=true → chỉ trong phiên (đúng Q7/Q8 cho nguồn thật);
 * - mặc định false → simulator chạy 24/7 cho demo (đã gắn nhãn "mô phỏng").
 */
export function shouldGenerateTicks(): boolean {
  if (process.env.MARKET_STRICT_SESSION === "true") {
    return isTradingSession(new Date());
  }
  return true;
}
