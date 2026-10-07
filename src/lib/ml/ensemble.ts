/**
 * src/lib/ml/ensemble.ts — ENSEMBLE MLP + LINREG (B7 — MARKET_EXPANSION_BLUEPRINT v1.1 §7.2).
 *
 * ML Forecast trở thành CỬ TRI THỨ 6 của Hội đồng Nghiên cứu (phiếu bầu theo
 * số đông — đồng thuận 80%): thay vì bằng chứng quant riêng, tín hiệu ML đi
 * vào Bayes ĐÚNG MỘT LẦN qua phiếu `llm-vote:ml-forecast` (evidence.ts đã
 * REPLACE block quant `mlp-forecast (MLP 10→16→8→3)` cũ — chống đếm kép T7.5).
 *
 * Công thức (chốt v1.1 sau review 37-REVIEW):
 *   score = 0,7 × (pUp − pDown)  +  0,3 × tanh(z)
 *   pUp/pDown   : MLP serving predictProba trung bình rổ top-10 HOSE-STOCK
 *                 (latestFeatures() — GIỮ NGUYÊN rổ bằng chứng quant #35).
 *   z           : z-score của đại lượng linreg proj₅ = slope×5/last×100
 *                 đo trên chuỗi rổ equal-weight, cửa sổ 60 phiên trượt
 *                 (định nghĩa "chuẩn hoá" tường minh — review P0 #2).
 *   deadband    : |score| < 0,05 → FLAT (thống nhất ngưỡng #35 — hàm sign()
 *                 thuần gần như không bao giờ FLAT, thiên lệch tally 2 cực).
 *   fallback    : chưa có MlModel serving → linreg thuần (modelVersion null,
 *                 direction theo ngưỡng ±1% như công thức runMlForecast #35).
 *
 * Deterministic, 0 LLM (~0,3s: loadTopSeries 10 mã + 1 forward MLP × 10).
 */

import { db } from "@/lib/db";
import { latestFeatures, loadTopSeries } from "@/lib/ml/features";
import { MLP } from "@/lib/ml/nn";

/** Deadband FLAT — |score| < 0,05 (B7 v1.1). */
export const ML_ENSEMBLE_DEADBAND = 0.05;
/** Trọng số MLP trong ensemble. */
const W_MLP = 0.7;
/** Trọng số linreg (tanh z) trong ensemble. */
const W_LINREG = 0.3;
/** Cửa sổ trượt tính proj₅ (phiên). */
const PROJ_WINDOW = 60;
/** Số phiên tối thiểu chuỗi rổ để tính z-score có nghĩa. */
const MIN_PROJ_SAMPLES = 10;

/** Kết quả ensemble — dùng cho runMlForecast + phiếu bầu evidence.ts. */
export interface MlEnsembleResult {
  direction: "UP" | "DOWN" | "FLAT";
  /** score = 0,7×(pUp−pDown) + 0,3×tanh(z); null khi fallback linreg thuần. */
  score: number | null;
  /** z-score của proj₅ (đại lượng linreg) — null khi thiếu dữ liệu chuỗi. */
  z: number | null;
  /** proj₅ phiên cuối của rổ (%) — đại lượng linreg thô. */
  lastProj: number | null;
  /** Trung bình xác suất MLP trên rổ (Σ=1); null khi fallback. */
  pUp: number | null;
  pDown: number | null;
  pFlat: number | null;
  /** max(pUp, pDown, pFlat) — BanditEvent.confidence (đầu vào Brier B8). */
  confidence: number;
  /** null = fallback linreg (chưa có MlModel serving). */
  modelVersion: number | null;
  /** Số mã trong rổ có đủ dữ liệu. */
  basketSize: number;
  /** Ghi chú 1 dòng (drivers + prompt). */
  note: string;
}

/** Hồi quy tuyến tính: slope chuỗi ys (bản nội bộ — không phụ thuộc module khác). */
function linregSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (ys[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den > 0 ? num / den : 0;
}

function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

function stdOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(meanOf(xs.map((x) => (x - m) * (x - m))));
}

/**
 * Tính ensemble ML Forecast. Trả null khi không đủ dữ liệu nền (rổ trống) —
 * module đọc (evidence/runMlForecast) phải bỏ phiếu im lặng, KHÔNG throw.
 */
export async function mlForecastEnsemble(): Promise<MlEnsembleResult | null> {
  /* ── 1. Phần linreg: rổ top-10 HOSE equal-weight → chuỗi proj₅ trượt ── */
  const series = await loadTopSeries(10);
  const usable = series.filter((s) => s.closes.length >= PROJ_WINDOW + MIN_PROJ_SAMPLES);
  if (usable.length === 0) return null;

  const m = Math.min(...usable.map((s) => s.closes.length));
  // Chuẩn hoá mỗi mã = 1.0 tại phiên đầu cửa sổ rồi lấy trung bình (equal-weight)
  const basket: number[] = [];
  for (let i = 0; i < m; i++) {
    let sum = 0;
    let cnt = 0;
    for (const s of usable) {
      const start = s.closes[s.closes.length - m];
      if (start > 0) {
        sum += s.closes[s.closes.length - m + i] / start;
        cnt++;
      }
    }
    basket.push(cnt > 0 ? sum / cnt : 1);
  }

  // proj₅ trượt trên cửa sổ 60 phiên: slope×5/last×100
  const projs: number[] = [];
  for (let i = PROJ_WINDOW - 1; i < basket.length; i++) {
    const win = basket.slice(i - PROJ_WINDOW + 1, i + 1);
    const last = basket[i];
    if (last > 0) projs.push((linregSlope(win) * 5) / last * 100);
  }
  const lastProj = projs.length > 0 ? projs[projs.length - 1] : null;
  const projMean = meanOf(projs);
  const projStd = stdOf(projs);
  const z =
    projs.length >= MIN_PROJ_SAMPLES && projStd > 0 && lastProj != null
      ? (lastProj - projMean) / projStd
      : null;

  /* ── 2. Phần MLP: MlModel serving → predictProba rổ top-10 ── */
  const model = await db.mlModel.findFirst({
    where: { kind: "dl-mlp", status: "serving" },
    select: { version: true, weights: true },
  });
  let pUp: number | null = null;
  let pDown: number | null = null;
  let pFlat: number | null = null;
  if (model) {
    try {
      const mlp = MLP.fromJSON(model.weights);
      const feats = await latestFeatures();
      if (feats.length > 0) {
        const probs = feats.map((f) => mlp.predictProba(f.x)); // [pUp, pFlat, pDown]
        let up = 0;
        let flat = 0;
        let down = 0;
        for (const p of probs) {
          up += p[0];
          flat += p[1];
          down += p[2];
        }
        const total = up + flat + down; // tái chuẩn hoá chống trôi Σ≠1
        if (total > 0) {
          pUp = up / total;
          pFlat = flat / total;
          pDown = down / total;
        }
      }
    } catch {
      // mô hình hỏng → fallback linreg im lặng
    }
  }

  /* ── 3. Ensemble score + deadband FLAT ── */
  let score: number | null = null;
  let direction: "UP" | "DOWN" | "FLAT";
  if (pUp != null && pDown != null) {
    score = W_MLP * (pUp - pDown) + (z != null ? W_LINREG * Math.tanh(z) : 0);
    direction =
      Math.abs(score) < ML_ENSEMBLE_DEADBAND ? "FLAT" : score > 0 ? "UP" : "DOWN";
  } else {
    // Fallback linreg thuần — ngưỡng ±1% như công thức runMlForecast #35
    direction =
      lastProj != null
        ? lastProj > 1
          ? "UP"
          : lastProj < -1
            ? "DOWN"
            : "FLAT"
        : "FLAT";
  }

  const confidence =
    pUp != null && pDown != null && pFlat != null
      ? Math.max(pUp, pDown, pFlat)
      : 0.5; // fallback linreg — tự tin khiêm tốn

  const parts: string[] = [];
  if (pUp != null && pDown != null) {
    parts.push(`MLP v${model?.version} pUp ${(pUp * 100).toFixed(1)}% / pDown ${(pDown * 100).toFixed(1)}%`);
  } else {
    parts.push(`linreg fallback (chưa có MlModel serving)`);
  }
  if (z != null) parts.push(`z=${z.toFixed(2)}`);
  if (lastProj != null) parts.push(`proj₅ ${lastProj >= 0 ? "+" : ""}${lastProj.toFixed(2)}%`);
  if (score != null) parts.push(`score ${score >= 0 ? "+" : ""}${score.toFixed(3)} (deadband ±0,05)`);
  const note = `Ensemble MLP+linreg top-${usable.length} HOSE: ${parts.join(" · ")} → ${direction === "UP" ? "TĂNG" : direction === "DOWN" ? "GIẢM" : "ĐI NGANG"}`;

  return {
    direction,
    score,
    z,
    lastProj,
    pUp,
    pDown,
    pFlat,
    confidence,
    modelVersion: model?.version ?? null,
    basketSize: usable.length,
    note,
  };
}
