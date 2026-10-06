/**
 * src/lib/quant/regime.ts — PHÂN LOẠI CHẾ ĐỘ THỊ TRƯỜNG (phiên #34).
 *
 * classifyRegime nhận chuỗi close của RỔ equal-weight basket index (mỗi mã
 * chuẩn hoá về 1 tại phiên đầu rồi lấy trung bình — như Backtest Officer A14):
 *  - VOLATILE  : stdev 20 phiên của basket daily returns > 1.8%/ngày.
 *  - BULL_TREND : SMA20 > SMA50 (ngắn hạn trên dài hạn).
 *  - BEAR_TREND : SMA20 < SMA50.
 *  - SIDEWAYS   : SMA20 ≈ SMA50 (trong dải ±0.15% quanh SMA50).
 *
 * Pure function — không DB.
 */

import { sma } from "@/lib/indicators";
import { stdev } from "@/lib/quant/statistics";

/** Chế độ thị trường 4 lớp. */
export type MarketRegime = "BULL_TREND" | "BEAR_TREND" | "SIDEWAYS" | "VOLATILE";

/** Nhãn tiếng Việt hiển thị. */
export const REGIME_LABELS: Record<MarketRegime, string> = {
  BULL_TREND: "Xu hướng tăng",
  BEAR_TREND: "Xu hướng giảm",
  SIDEWAYS: "Đi ngang",
  VOLATILE: "Biến động cao",
};

/** Kết quả phân loại kèm số liệu nền. */
export interface RegimeResult {
  regime: MarketRegime;
  /** Nhãn tiếng Việt (trực tiếp dùng cho narrative/UI). */
  label: string;
  sma20: number | null;
  sma50: number | null;
  /** Độ lệch chuẩn daily returns 20 phiên gần nhất (thập phân, vd 0.012 = 1.2%). */
  vol20: number;
}

/** Ngưỡng vol biểu kiến "biến động cao" — 1.8%/ngày (spec phiên #34). */
export const VOLATILE_THRESHOLD = 0.018;

/** Dải SMA20 xấp xỉ SMA50 coi là đi ngang (±0.15%). */
const SIDEWAYS_EPS = 0.0015;

/**
 * Phân loại chế độ thị trường từ basket index closes (tăng dần theo thời gian).
 * Chuỗi < 21 phiên → SIDEWAYS mặc định (chưa đủ dữ liệu kết luận xu hướng).
 */
export function classifyRegime(basketCloses: number[]): RegimeResult {
  const sma20 = sma(basketCloses, 20);
  const sma50 = sma(basketCloses, 50);

  // Biến động 20 phiên gần nhất của basket
  const tail = basketCloses.slice(-21);
  const rets: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    if (tail[i - 1] > 0) rets.push(tail[i] / tail[i - 1] - 1);
  }
  const vol20 = stdev(rets);

  let regime: MarketRegime;
  if (rets.length >= 15 && vol20 > VOLATILE_THRESHOLD) {
    // Biến động cao thắng mọi xu hướng — tín hiệu giảm niềm tin mọi dự báo
    regime = "VOLATILE";
  } else if (sma20 == null || sma50 == null || sma50 <= 0) {
    regime = "SIDEWAYS";
  } else if (sma20 > sma50 * (1 + SIDEWAYS_EPS)) {
    regime = "BULL_TREND";
  } else if (sma20 < sma50 * (1 - SIDEWAYS_EPS)) {
    regime = "BEAR_TREND";
  } else {
    regime = "SIDEWAYS";
  }

  return { regime, label: REGIME_LABELS[regime], sma20, sma50, vol20 };
}
