/**
 * S3 — Feature flag giao dịch thật (DATA_SOURCES.md §4.1 + blueprint §8).
 *
 * LIVE_TRADING=false (mặc định) → mọi Order là PAPER order nội bộ.
 * Bật LIVE_TRADING=true yêu cầu cấu hình thêm:
 *   VNDIRECT_API_BASE, VNDIRECT_API_TOKEN (env server-side, không commit).
 * Chưa cấu hình đủ → từ chối với thông báo rõ ràng + audit log.
 */

export interface TradingModeInfo {
  /** LIVE_TRADING === "true" */
  live: boolean;
  /** Đã đủ VNDIRECT_API_BASE + VNDIRECT_API_TOKEN */
  configured: boolean;
  mode: "paper" | "live" | "live-unconfigured";
}

export function getTradingMode(): TradingModeInfo {
  const live = process.env.LIVE_TRADING === "true";
  const configured = Boolean(
    process.env.VNDIRECT_API_BASE && process.env.VNDIRECT_API_TOKEN
  );
  return {
    live,
    configured,
    mode: live ? (configured ? "live" : "live-unconfigured") : "paper",
  };
}

export type LiveGate =
  | { ok: true; mode: "live" }
  | { ok: false; mode: "paper" | "live-unconfigured"; error: string };

/**
 * Cổng kiểm tra trước khi gửi lệnh thật. Paper mode vẫn cho chạy paper-flow
 * (đây là hành vi mặc định); chỉ live-unconfigured là bị chặn.
 */
export function liveTradingGate(): LiveGate {
  const t = getTradingMode();
  if (t.mode === "paper") {
    return {
      ok: false,
      mode: "paper",
      error: "Chế độ PAPER (LIVE_TRADING=false) — lệnh chỉ là giấy, không gửi ra VNDIRECT.",
    };
  }
  if (t.mode === "live-unconfigured") {
    return {
      ok: false,
      mode: "live-unconfigured",
      error:
        "LIVE_TRADING=bật nhưng thiếu cấu hình VNDIRECT_API_BASE / VNDIRECT_API_TOKEN trong .env. Hệ thống từ chối gửi lệnh thật cho đến khi đủ cấu hình.",
    };
  }
  return { ok: true, mode: "live" };
}

export const TRADING_MODE_LABEL: Record<TradingModeInfo["mode"], string> = {
  paper: "Giao dịch giấy (paper)",
  live: "Giao dịch thật VNDIRECT",
  "live-unconfigured": "Giao dịch thật (chưa cấu hình)",
};
