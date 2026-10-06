/**
 * Lịch & phiên giao dịch VN (Q7/Q8 — DATA_SOURCES.md §5).
 * Timezone tính toán: Asia/Ho_Chi_Minh (UTC+7).
 */

/** Ngày VN "thật" của một thời điểm UTC (dịch +7h rồi lấy phần UTC). */
function vnShift(date: Date): Date {
  return new Date(date.getTime() + 7 * 3_600_000);
}

/** Ngày ISO (YYYY-MM-DD) theo Asia/Ho_Chi_Minh — ranh giới ngày luôn theo ICT (F-212). */
export function vnDateIso(date: Date = new Date()): string {
  return vnShift(date).toISOString().slice(0, 10);
}

/** Lịch nghỉ lễ Việt Nam (ước lượng, cập nhật hàng năm). */
const VN_HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", // Tết Dương lịch
  "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", // Tết Bính Ngọ
  // F-110 (audit): Giỗ Tổ 10/3 âm = CN 26/04/2026 → thị trường nghỉ bù thứ Hai 27/04
  "2026-04-27",
  "2026-04-30", "2026-05-01", // 30/4 & 1/5
  "2026-09-02", "2026-09-03", // Quốc khánh
]);

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
