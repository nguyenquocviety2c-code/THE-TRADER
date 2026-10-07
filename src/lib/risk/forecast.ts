/**
 * src/lib/risk/forecast.ts — CRB-6 · HỒI QUY LOGISTIC P(vi phạm 5 phiên) +
 * CRB-8 · CUSUM/EWMA CONTROL CHART (CONTROL_RISK_QUANT_BLUEPRINT v1.1 §5).
 *
 * CRB-6 (viết tay phong cách ml/nn.ts — full-batch GD + ridge):
 *   8 đặc trưng (TẤT CẢ có sẵn, không lookahead):
 *     x1 volZ = (σ_ewma20 − volRef)/volRef · x2 rsiBucket rổ (0..3)/3 ·
 *     x3 mom5 rổ (tanh) · x4 exposure (invested fraction) · x5 ddNow/0,15 ·
 *     x6 hhiSector · x7 avgCorr · x8 volRatio20/60
 *   Nhãn PHA 1 (proxy rổ — chốt user #50 Q3): rổ top-10 có |ret 5 phiên|
 *   ≤ −2% (đuôi xấu) → 1. PHA 2 khi RiskQuantSnapshot ≥ 250 chu kỳ: retrain
 *   nhãn = vi phạm hạn mức THẬT (navSeries) — modelVersion phân biệt.
 *   Huấn luyện: full-batch GD + ridge λ=0,01 · lr=0,1 · ≤500 epoch · seed 2026
 *   · chuẩn hoá z-score như MLP · AUC trên split thời gian 80/20.
 *   Serving: p_breach = σ(βᵀx) → LR = clamp((p/(1−p))/(p₀/(1−p₀)), 0,5, 3,0)
 *   (p₀ = base-rate tập train — so odds với nền, KHÔNG odds thô).
 *   AUC val ≥ 0,55 mới được serving (dưới → chỉ log, không vào Bayes).
 *
 * CRB-8:
 *   CUSUM một phía downside: Sₜ = max(0, Sₜ₋₁ + (−rₜ − k)), k = 0,5σ, h = 4σ
 *   (S₊ downside-drift quan sát chế độ). BÁO ĐỘNG khi Sₜ > h + reset S sau
 *   báo động (cooldown 1 ngày chống alert chồng — engine xử lý).
 *   EWMA chart biến động: zₜ = μ·rₜ + (1−μ)·zₜ₋₁, μ = 0,1 (chart smoothing —
 *   TÁCH ký hiệu khỏi λ RiskMetrics 0,94 CRB-1); giới hạn ±L·σ·√(μ/(2−μ)),
 *   L = 2,7 → WARN vol-shift.
 *
 * Thuần TypeScript, Float64Array, RNG mulberry32 seed cố định — 0 dependency.
 */

import { mulberry32 } from "@/lib/risk/tail";

/** Ridge logistic — siêu tham số (chốt thiết kế §5). */
export const LOGIT_RIDGE_LAMBDA = 0.01;
export const LOGIT_LR = 0.1;
export const LOGIT_MAX_EPOCHS = 500;
export const LOGIT_SEED = 2026;
/** Ngưỡng AUC serving (nghiệm thu CRB-6.1 — trung thực, dưới ngưỡng chỉ log). */
export const LOGIT_AUC_SERVE = 0.55;
/** Ngưỡng nhãn đuôi xấu PHA 1 (rổ 5 phiên ≤ −2%). */
export const BREACH_LABEL_THRESHOLD = -0.02;
/** Base-rate PRIOR khi tập train không có dương tính nào (0,5% — khiêm tốn). */
const BASE_RATE_FLOOR = 0.005;

/** Mô hình logistic 8 đặc trưng + intercept. */
export interface BreachLogitModel {
  /** β — 9 hệ số (intercept + 8 đặc trưng), áp trên vector CHUẨN HOÁ. */
  beta: number[];
  /** mean/std chuẩn hoá z-score (fit trên train). */
  mean: number[];
  std: number[];
  /** AUC trên split thời gian 80/20. */
  auc: number;
  /** Base-rate tập train (p₀ — nền so odds). */
  baseRate: number;
  /** Số mẫu train/val. */
  trainSamples: number;
  valSamples: number;
  modelVersion: string;
  /** true khi AUC ≥ 0,55 — được phép serving. */
  served: boolean;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/** Z-score hoá theo cột (std = 0 → 1 — cột hằng). */
function standardize(X: number[][]): { mean: number[]; std: number[]; Xstd: number[][] } {
  const n = X.length;
  const d = n > 0 ? X[0].length : 0;
  const mean = new Array<number>(d).fill(0);
  const std = new Array<number>(d).fill(1);
  if (n === 0) return { mean, std, Xstd: [] };
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (let j = 0; j < d; j++) {
    let v = 0;
    for (const row of X) v += (row[j] - mean[j]) * (row[j] - mean[j]);
    v /= n;
    std[j] = v > 1e-12 ? Math.sqrt(v) : 1;
  }
  const Xstd = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  return { mean, std, Xstd };
}

/** AUC Rank (Mann-Whitney) — deterministic, không drag cặp bằng. */
function aucRank(y: number[], p: number[]): number {
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  if (pos === 0 || neg === 0) return 0.5;
  const order = p.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  // rank trung bình cho cặp bằng nhau
  const ranks = new Array<number>(y.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const avg = (i + j) / 2 + 1; // rank 1-based trung bình
    for (let k = i; k <= j; k++) ranks[order[k].i] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  for (let k = 0; k < y.length; k++) if (y[k] === 1) sumPos += ranks[k];
  return (sumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/**
 * CRB-6 — huấn luyện logistic ridge trên (features, labels) THEO THỜI GIAN
 * (caller đã sắp tăng dần — split 80/20 block thời gian, val = block mới
 * nhất). Trả mô hình + served flag; lỗi/đặt mẫu cạn → served=false (engine
 * ghi log, KHÔNG bịa p).
 */
export function trainBreachLogit(
  features: number[][],
  labels: number[],
  modelVersion = "phase1-basket"
): BreachLogitModel {
  const n = features.length;
  const empty = {
    beta: [],
    mean: [],
    std: [],
    auc: 0,
    baseRate: BASE_RATE_FLOOR,
    trainSamples: 0,
    valSamples: 0,
    modelVersion,
    served: false,
  };
  if (n < 60) return { ...empty, trainSamples: n };
  const positives = labels.reduce((s, v) => s + (v === 1 ? 1 : 0), 0);
  if (positives < 5 || positives > n - 5) {
    // Quá lệch class (thiếu đuôi xấu để học) — trung thực không serving
    return { ...empty, trainSamples: n, baseRate: Math.max(BASE_RATE_FLOOR, positives / n) };
  }

  // Split thời gian 80/20
  const cut = Math.floor(n * 0.8);
  const Xtr = features.slice(0, cut);
  const ytr = labels.slice(0, cut);
  const Xva = features.slice(cut);
  const yva = labels.slice(cut);
  const { mean, std, Xstd } = standardize(Xtr);
  const XvaStd = Xva.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));

  const d = Xtr[0].length + 1; // + intercept
  const rng = mulberry32(LOGIT_SEED);
  const beta = new Array<number>(d).fill(0);
  for (let j = 0; j < d; j++) beta[j] = (rng() - 0.5) * 0.02; // khởi tạo nhỏ seed 2026

  const m = Xstd.length;
  for (let epoch = 0; epoch < LOGIT_MAX_EPOCHS; epoch++) {
    const grad = new Array<number>(d).fill(0);
    for (let i = 0; i < m; i++) {
      const row = Xstd[i];
      let z = beta[0];
      for (let j = 1; j < d; j++) z += beta[j] * row[j - 1];
      const err = sigmoid(z) - ytr[i];
      grad[0] += err;
      for (let j = 1; j < d; j++) grad[j] += err * row[j - 1];
    }
    // Ridge (không phạt intercept) + cập nhật full-batch
    beta[0] -= (LOGIT_LR * grad[0]) / m;
    for (let j = 1; j < d; j++) {
      beta[j] -= (LOGIT_LR * (grad[j] / m + LOGIT_RIDGE_LAMBDA * beta[j]));
    }
  }

  const pVal = XvaStd.map((row) => {
    let z = beta[0];
    for (let j = 1; j < d; j++) z += beta[j] * row[j - 1];
    return sigmoid(z);
  });
  const auc = aucRank(yva, pVal);
  const baseRate = Math.max(BASE_RATE_FLOOR, ytr.reduce((s, v) => s + v, 0) / m);

  return {
    beta,
    mean,
    std,
    auc,
    baseRate,
    trainSamples: m,
    valSamples: Xva.length,
    modelVersion,
    served: auc >= LOGIT_AUC_SERVE,
  };
}

/** Dự đoán p_breach từ mô hình đã chuẩn hoá (serving). */
export function predictBreach(model: BreachLogitModel, x: number[]): number {
  if (!model.served || model.beta.length === 0) return 0;
  let z = model.beta[0];
  for (let j = 1; j < model.beta.length; j++) {
    const v = (x[j - 1] ?? 0) - (model.mean[j - 1] ?? 0);
    const sd = model.std[j - 1] ?? 1;
    z += model.beta[j] * (v / (sd || 1));
  }
  return sigmoid(z);
}

/** LR so odds với base-rate nền (p₀) — clamp [0,5 · 3,0] ràng buộc synthesis. */
export function breachOddsLr(model: BreachLogitModel, p: number): number {
  if (!model.served || p <= 1e-6 || p >= 1 - 1e-6) return 1;
  const p0 = Math.min(0.5, Math.max(0.01, model.baseRate));
  const odds = (p / (1 - p)) / (p0 / (1 - p0));
  return Math.min(3.0, Math.max(0.5, odds));
}

/* ─────────────────── CRB-8 · CUSUM + EWMA control chart ─────────────────── */

/** k = 0,5σ · h = 4σ (chuẩn ARL ≈ 5% giả dương). */
export const CUSUM_K_SIGMA = 0.5;
export const CUSUM_H_SIGMA = 4;
/** μ làm mượt EWMA chart (TÁCH khỏi λ RiskMetrics — bài học review #50-b). */
export const EWMA_CHART_MU = 0.1;
/** L hệ số giới hạn chart ±L·σ·√(μ/(2−μ)) — L = 2,7. */
export const EWMA_CHART_L = 2.7;

/** Kết quả CRB-8. */
export interface DriftResult {
  /** CUSUM downside Sₜ hiện tại. */
  s: number;
  /** CUSUM upside S₺ (thông tin chế độ — không báo động). */
  sPlus: number;
  /** Ngưỡng h = 4σ. */
  h: number;
  /** true khi S > h (báo động trôi dạt xuống). */
  alarm: boolean;
  /** Số phiên còn cách DD ngưỡng theo trend CUSUM (ngoại suy tuyến tính —
   * chỉ mô tả, không dự báo; null khi không thể ngoại suy). */
  sessionsToDd: number | null;
  /** EWMA chart z hiện tại. */
  chartZ: number;
  /** Giới hạn chart ±L·σ·√(μ/(2−μ)). */
  chartLimit: number;
  /** true khi |z| > limit (vol-shift). */
  chartAlarm: boolean;
  /** σ dùng cho CUSUM (stdev returns 60 phiên). */
  sigma: number;
}

/** Stdev mẫu (n−1) của mảng. */
export function stdev(values: Float64Array | number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) m += values[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (values[i] - m) * (values[i] - m);
  return Math.sqrt(v / (n - 1));
}

/**
 * CRB-8 — CUSUM downside/upside + EWMA vol chart trên chuỗi return
 * (NAV thật từ RiskQuantSnapshot ≥ 60 điểm; PHA 1 thiếu → rổ proxy —
 * engine chọn nguồn). Reset S sau báo động: caller truyền S trước đó = 0
 * khi cooldown đã chặt (engine quản lý cooldown 1 ngày).
 */
export function computeDrift(
  returns: Float64Array,
  options: { ddNow?: number; ddThreshold?: number } = {}
): DriftResult {
  const n = returns.length;
  const win = returns.subarray(Math.max(0, n - 60));
  const sigma = stdev(win);
  if (n < 20 || sigma < 1e-12) {
    return {
      s: 0,
      sPlus: 0,
      h: 0,
      alarm: false,
      sessionsToDd: null,
      chartZ: 0,
      chartLimit: 0,
      chartAlarm: false,
      sigma,
    };
  }
  const k = CUSUM_K_SIGMA * sigma;
  const h = CUSUM_H_SIGMA * sigma;
  let s = 0;
  let sPlus = 0;
  let alarm = false;
  for (let i = 0; i < win.length; i++) {
    const r = win[i];
    s = Math.max(0, s + (-r - k));
    sPlus = Math.max(0, sPlus + (r - k));
    if (s > h) {
      alarm = true;
      s = 0; // reset sau báo động (nghiệm thu CRB-8.3 — tránh alert chồng)
    }
  }
  // Ngoại suy tuyến tính thuần mô tả: drift trung bình/phiên = S tích luỹ
  // trước reset ~ (alarm ? h : s)/phiên — ước lượng thô trung thực
  const ddNow = Math.max(0, options.ddNow ?? 0);
  const ddThreshold = Math.max(0.01, options.ddThreshold ?? 0.15);
  let sessionsToDd: number | null = null;
  const driftPerSession = sigma > 0 ? (alarm ? h : s) / Math.max(1, win.length) : 0;
  if (driftPerSession > 1e-9 && ddNow < ddThreshold) {
    sessionsToDd = Math.round((ddThreshold - ddNow) / driftPerSession);
  }

  // EWMA chart biến động — zₜ = μ·rₜ + (1−μ)·zₜ₋₁ (seed z₀ = 0)
  let z = 0;
  for (let i = 0; i < win.length; i++) z = EWMA_CHART_MU * win[i] + (1 - EWMA_CHART_MU) * z;
  const chartLimit = EWMA_CHART_L * sigma * Math.sqrt(EWMA_CHART_MU / (2 - EWMA_CHART_MU));

  return {
    s: alarm ? h : s, // S hiển thị = giá trị tại báo động (đã reset nội bộ)
    sPlus,
    h,
    alarm,
    sessionsToDd,
    chartZ: z,
    chartLimit,
    chartAlarm: Math.abs(z) > chartLimit,
    sigma,
  };
}
