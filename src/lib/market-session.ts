/**
 * Lịch & phiên giao dịch VN (Q7/Q8 — DATA_SOURCES.md §5).
 * Timezone tính toán: Asia/Ho_Chi_Minh (UTC+7).
 */

/** Ngày VN "thật" của một thời điểm UTC (dịch +7h rồi lấy phần UTC). */
function vnShift(date: Date): Date {
  return new Date(date.getTime() + 7 * 3_600_000);
}

/** Lịch nghỉ lễ Việt Nam (ước lượng, cập nhật hàng năm). */
const VN_HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", // Tết Dương lịch
  "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", // Tết Bính Ngọ
  "2026-04-10", // Giỗ Tổ Hùng Vương (10/3 âm)
  "2026-04-30", "2026-05-01", // 30/4 & 1/5
  "2026-09-02", "2026-09-03", // Quốc khánh
]);

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
  const v = vnShift(date);
  const m = v.getUTCHours() * 60 + v.getUTCMinutes();
  return (m >= 555 && m <= 690) || (m >= 780 && m <= 885);
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
  const v = vnShift(date);
  const m = v.getUTCHours() * 60 + v.getUTCMinutes();
  if (m < 555) return "pre-open";
  if (m <= 690) return "morning";
  if (m < 780) return "lunch";
  if (m <= 885) return "afternoon";
  if (m <= 900) return "atc";
  return "closed";
}

export const SESSION_PHASE_LABEL: Record<SessionPhase, string> = {
  "pre-open": "ATO 09:00–09:15",
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
