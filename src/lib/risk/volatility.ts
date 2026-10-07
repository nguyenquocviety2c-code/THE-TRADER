/**
 * src/lib/risk/volatility.ts — CRB-1 · EWMA VOLATILITY + HẠN MỨC ĐỘNG
 * (CONTROL_RISK_QUANT_BLUEPRINT v1.1 §3 — phiên #51).
 *
 * RiskMetrics chuẩn:
 *   σ²ₜ = λ·σ²ₜ₋₁ + (1−λ)·r²ₜ        λ = 0,94 (daily)
 *   σ_ann = σ_daily × √252
 *
 * Hạn mức động HAI CHIỀU CÓ TRẦN (chốt user #50 Q2 — §0.3):
 *   volRef = median(σ_ewma 250 phiên gần nhất)   — mốc "bình thường" (median,
 *           không mean — chống nhiễu đỉnh spike)
 *   mult   = clamp(volRef / σ_ewma_now, 0,6, 1,15) — SIẾT khi vol cao hơn mốc,
 *           NỚI tối đa +15% khi YÊN BÌNH hơn mốc (mọi lần nới → INFO alert)
 *   dynMax = static × mult
 *
 * Thuần TypeScript, Float64Array, deterministic — 0 dependency, 0 LLM.
 */

/** Hệ số làm mượt (decay) RiskMetrics daily chuẩn. */
export const EWMA_LAMBDA = 0.94;
/** Số phiên giao dịch 1 năm (chuẩn VN). */
export const TRADING_DAYS_YEAR = 252;
/** Cửa sổ tính mốc tham chiếu volRef (median). */
export const VOL_REF_WINDOW = 250;
/** Biên mult dưới (siết tối đa 40%) và trên (nới tối đa +15% — trần CỨNG). */
export const MULT_FLOOR = 0.6;
export const MULT_CEILING = 1.15;

/** Kết quả CRB-1. */
export interface VolatilityResult {
  /** σ EWMA hiện tại (daily, dạng thập phân — 0,01 = 1%/phiên). */
  sigmaDaily: number;
  /** σ năm hoá (%) — hiển thị + prompt risk-manager. */
  sigmaAnnPct: number;
  /** Mốc bình thường median σ 250 phiên (daily). */
  volRef: number;
  /** σ_now / σ_ref (1 = bình thường; 1,5 = biến động cao 50%). */
  volRatio: number;
  /** Hệ số hạn mức động ∈ [0,6 · 1,15]. */
  mult: number;
  /** Hạn mức vị thế động (% NAV). */
  dynMaxPositionPct: number;
  /** Hạn mức ngành động (% NAV). */
  dynMaxSectorPct: number;
  /** true khi mult > 1 (nới hạn mức — luôn phát INFO alert ở engine). */
  loosened: boolean;
  /** Số phiên chuỗi đầu vào (n < 60 → caller phải chạy proxy mode). */
  sessions: number;
}

/**
 * Chuỗi σ EWMA (daily) từ chuỗi return — cùng độ dài input (phần tử đầu =
 * seed |r₀|). σ²ₜ = λσ²ₜ₋₁ + (1−λ)r²ₜ, khởi tạo σ²₀ = r²₀.
 */
export function ewmaSigmaSeries(returns: Float64Array, lambda = EWMA_LAMBDA): Float64Array {
  const n = returns.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  let prevVar = returns[0] * returns[0];
  out[0] = Math.sqrt(prevVar);
  for (let i = 1; i < n; i++) {
    prevVar = lambda * prevVar + (1 - lambda) * returns[i] * returns[i];
    out[i] = Math.sqrt(prevVar);
  }
  return out;
}

/** Trung vị của mảng (copy rồi sort — không đổi input). */
export function median(values: Float64Array | number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * CRB-1 — tính σ EWMA + hạn mức động hai chiều từ chuỗi return danh mục
 * (hoặc rổ proxy). staticMaxPositionPct/staticMaxSectorPct đọc từ roster
 * config (AUD-CODE #15 — MỘT nguồn sự thật hạn mức tĩnh).
 */
export function computeVolatility(
  returns: Float64Array,
  staticLimits: { maxPositionPct: number; maxSectorWeightPct: number }
): VolatilityResult {
  const n = returns.length;
  const sigmaSeries = ewmaSigmaSeries(returns);
  const sigmaNow = n > 0 ? sigmaSeries[n - 1] : 0;
  // Mốc bình thường: median σ chuỗi (cửa sổ ≤ 250 phiên gần nhất)
  const refWindow = sigmaSeries.subarray(Math.max(0, n - VOL_REF_WINDOW));
  const volRef = median(refWindow);

  // mult = clamp(volRef/σ_now, 0,6, 1,15) — σ_now = 0 (chuỗi phẳng hoàn toàn)
  // → coi như yên bình tuyệt đối → mult = trần 1,15 (không chia 0).
  const rawMult = sigmaNow > 1e-12 ? volRef / sigmaNow : MULT_CEILING;
  const mult = Math.min(MULT_CEILING, Math.max(MULT_FLOOR, rawMult));

  return {
    sigmaDaily: sigmaNow,
    sigmaAnnPct: sigmaNow * Math.sqrt(TRADING_DAYS_YEAR) * 100,
    volRef,
    volRatio: volRef > 1e-12 ? sigmaNow / volRef : 1,
    mult,
    dynMaxPositionPct: staticLimits.maxPositionPct * mult,
    dynMaxSectorPct: staticLimits.maxSectorWeightPct * mult,
    loosened: mult > 1 + 1e-9,
    sessions: n,
  };
}

/**
 * Nghiệm thu (3b): mult > 1 chỉ xảy ra khi σ_now < σ_ref (yên bình hơn mốc).
 * Kiểm tra bất biến — dùng cho self-check trong engine (không throw khi
 * chuỗi rỗng; caller xử lý proxy mode).
 */
export function assertLoosenInvariant(result: VolatilityResult): boolean {
  if (result.mult <= 1 + 1e-9) return true;
  return result.sigmaDaily < result.volRef + 1e-12;
}
