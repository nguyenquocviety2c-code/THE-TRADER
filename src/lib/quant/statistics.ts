/**
 * src/lib/quant/statistics.ts — HÀM THỐNG KÊ THUẦN cho Bộ tổng hợp Bayes
 * (Phiên #34 — NHIỆM VỤ 1).
 *
 * Toàn bộ pure functions: KHÔNG dùng DB, KHÔNG side-effect, KHÔNG mutate input.
 * Input rỗng → trả giá trị an toàn (0 / null) — caller tự kiểm tra.
 */

/** Trung bình cộng; mảng rỗng → 0. */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Độ lệch chuẩn MẪU (n−1; Bessel correction); mảng < 2 phần tử → 0. */
export function stdev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let sq = 0;
  for (const x of xs) sq += (x - m) * (x - m);
  return Math.sqrt(sq / (n - 1));
}

/**
 * z-score của `value` so với phân phối mẫu `xs` (mean & stdev mẫu).
 * stdev = 0 (chuỗi phẳng) → 0 (không lệch nào đo được).
 */
export function zscore(value: number, xs: number[]): number {
  const sd = stdev(xs);
  if (sd <= 0) return 0;
  return (value - mean(xs)) / sd;
}

/**
 * Percentile rank của `value` trong `xs` (0..100) — tỉ lệ phần tử ≤ value,
 * theo phép nội suy tuyến tính chuẩn (Giải thuật NIST).
 */
export function percentileRank(xs: number[], value: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  if (value <= sorted[0]) return 0;
  if (value >= sorted[sorted.length - 1]) return 100;
  // Đếm số phần tử nhỏ hơn value (rightmost index với sorted[i] <= value)
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (sorted[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  // Nội suy giữa sorted[i] và sorted[i+1]
  const x0 = sorted[i];
  const x1 = sorted[Math.min(i + 1, sorted.length - 1)];
  const frac = x1 > x0 ? (value - x0) / (x1 - x0) : 0;
  return ((i + frac) / (sorted.length - 1)) * 100;
}

/** Kết quả OLS y = a + b·t trên chuỗi (x = 0..n−1). */
export interface LinregResult {
  slope: number;
  intercept: number;
  /** Hệ số quyết định R² (0..1; 0 khi không có biến thiên). */
  r2: number;
  /** Độ lệch chuẩn residual (mẫu) — biên độ nhiễu quanh đường hồi quy. */
  sigma: number;
}

/**
 * Hồi quy tuyến tính OLS của `ys` theo chỉ số thời gian 0..n−1.
 * Dùng cho dự báo momentum (ml-forecast style) và đo xu hướng.
 */
export function linreg(ys: number[]): LinregResult {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? ys[0] : 0, r2: 0, sigma: 0 };
  const xMean = (n - 1) / 2;
  const yMean = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (ys[i] - yMean);
    den += (i - xMean) * (i - xMean);
  }
  const slope = den > 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;
  const residuals: number[] = [];
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * i;
    residuals.push(ys[i] - pred);
    ssTot += (ys[i] - yMean) * (ys[i] - yMean);
  }
  const ssRes = residuals.reduce((s, r) => s + r * r, 0);
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope, intercept, r2, sigma: stdev(residuals) };
}

/**
 * Sharpe ratio năm hoá từ chuỗi LỢI NHUẬN NGÀY (daily returns, thập phân).
 * Giả định risk-free = 0 (chuẩn paper-trading). Mảng < 2 hoặc std = 0 → null.
 */
export function sharpe(dailyReturns: number[], periodsPerYear = 252): number | null {
  if (dailyReturns.length < 2) return null;
  const sd = stdev(dailyReturns);
  if (sd <= 0) return null;
  return (mean(dailyReturns) / sd) * Math.sqrt(periodsPerYear);
}

/**
 * Drawdown tối đa (peak-to-trough) của chuỗi giá trị, trả dưới dạng
 * BIÊN ĐỘ DƯƠNG (0..1; 0.15 = sụt 15% so đỉnh).
 */
export function maxDrawdown(series: number[]): number {
  if (series.length < 2) return 0;
  let peak = series[0];
  let maxDd = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/** Tần suất lịch sử ngày tăng/giảm/đi ngang của cả rổ (base-rate tiên nghiệm). */
export interface BaseRates {
  pUp: number;
  pDown: number;
  pFlat: number;
  /** Tổng số quan sát (mã × phiên) dùng đo base-rate. */
  sampleCount: number;
  /** Số phiên thực sự thống kê trên mỗi mã. */
  sessionsPerSymbol: number;
}

/**
 * Base-rate lịch sử từ mảng closes của NHIỀU MÃ: gộp mọi biến động ngày của
 * rổ trong `sessions` phiên gần nhất, đếm tần suất tăng/giảm/đi ngang
 * (đi ngang = |change| < flatThresholdPct, mặc định 0.15% — đúng ngưỡng
 * quy định trần/sàn của sàn HOSE để loãng nhiễu làm tròn giá).
 * Kết quả luôn cộng đúng = 1 (mẫu rỗng → 1/3 mỗi lớp — vô thông tin).
 */
export function historicalBaseRates(
  closesBySymbol: number[][],
  options: { sessions?: number; flatThresholdPct?: number } = {}
): BaseRates {
  const sessions = Math.max(30, options.sessions ?? 250);
  const flatThresholdPct = options.flatThresholdPct ?? 0.15;
  let up = 0;
  let down = 0;
  let flat = 0;
  let sessionsPerSymbol = 0;
  for (const closes of closesBySymbol) {
    const window = closes.slice(-sessions - 1); // +1 để có đủ `sessions` biến động
    for (let i = 1; i < window.length; i++) {
      if (window[i - 1] <= 0) continue;
      const chgPct = ((window[i] - window[i - 1]) / window[i - 1]) * 100;
      if (chgPct > flatThresholdPct) up++;
      else if (chgPct < -flatThresholdPct) down++;
      else flat++;
      if (i === window.length - 1) sessionsPerSymbol = Math.max(sessionsPerSymbol, window.length - 1);
    }
  }
  const total = up + down + flat;
  if (total === 0) return { pUp: 1 / 3, pDown: 1 / 3, pFlat: 1 / 3, sampleCount: 0, sessionsPerSymbol: 0 };
  return { pUp: up / total, pDown: down / total, pFlat: flat / total, sampleCount: total, sessionsPerSymbol };
}

/** Hệ số tương quan Pearson của 2 chuỗi bằng chiều dài; < 2 cặp hoặc vô phương sai → null. */
export function correlation(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const x = xs.slice(xs.length - n);
  const y = ys.slice(ys.length - n);
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) * (x[i] - mx);
    dy += (y[i] - my) * (y[i] - my);
  }
  if (dx <= 0 || dy <= 0) return null;
  return Math.max(-1, Math.min(1, num / Math.sqrt(dx * dy)));
}

/** Logistic sigmoid σ(x) — dùng chung cho log-odds posterior. */
export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** logit p = ln(p / (1−p)); p ngoài (0,1) được kẹp biên để hữu hạn. */
export function logit(p: number): number {
  const clamped = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(clamped / (1 - clamped));
}

/** Entropy Shannon (nats) của phân phối xác suất; bỏ qua p = 0. */
export function entropy(ps: number[]): number {
  let h = 0;
  for (const p of ps) {
    if (p > 0) h -= p * Math.log(p);
  }
  return h;
}
