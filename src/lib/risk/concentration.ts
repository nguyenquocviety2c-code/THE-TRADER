/**
 * src/lib/risk/concentration.ts — CRB-4 · HHI TẬP TRUNG + CRB-5 · MA TRẬN
 * TƯƠNG QUAN / "SỐ CƯỢC HIỆU QUẢ" (CONTROL_RISK_QUANT_BLUEPRINT v1.1 §4).
 *
 * CRB-4 (vá gap §1.2 — "3 ngành × 39% vẫn ĐẠT" của A7 cũ):
 *   HHI_sector   = Σⱼ sⱼ²   (sⱼ = tỷ trọng ngành / NAV)
 *   HHI_position = Σᵢ wᵢ²   (wᵢ = tỷ trọng vị thế / NAV)
 *   N_eff = 1 / HHI         (≈ số thành phần "độc lập" đẳng trọng)
 *   Ngưỡng: HHI_sector > 0,25 (< 4 ngành hiệu quả) HOẶC HHI_position > 0,15
 *   (< 6,7 vị thế hiệu quả vs targetPositions: 8) → cảnh báo tập trung —
 *   HHI là tín hiệu SIÊT SỚM, VETO A7 giữ nguyên ranh giới hạn mức.
 *
 * CRB-5:
 *   corr(i,j) = Pearson(rᵢ, rⱼ) trên ≤ 60 PHIÊN CHUNG theo NGÀY, chỉ top-15
 *   vị thế theo MV (cap ma trận 15×15); cặp < 40 phiên chung → bỏ (đếm
 *   pairsDropped) — "phiên chung" = NGÀY có return ở CẢ HAI mã (fixbug #52:
 *   ghép theo index đầu sẽ lệch ngày khi mã đình quyền/thiếu phiên)
 *   avgCorr  = trung bình corr các cặp i<j
 *   N_eff_bets = N / (1 + (N−1)·avgCorr)
 *
 * Thuần TypeScript, Float64Array — 0 dependency.
 */

/** Ngưỡng HHI ngành / vị thế (chốt thiết kế §4). */
export const HHI_SECTOR_THRESHOLD = 0.25;
export const HHI_POSITION_THRESHOLD = 0.15;
/** Cửa sổ tương quan (phiên). */
export const CORR_WINDOW = 60;
/** Số phiên chung tối thiểu cho một cặp tương quan. */
export const CORR_MIN_OVERLAP = 40;
/** Cap số vị thế tính tương quan (top theo MV). */
export const CORR_TOP_N = 15;
/** Ngưỡng cảnh báo tương quan. */
export const AVG_CORR_THRESHOLD = 0.7;

/** Kết quả CRB-4. */
export interface ConcentrationResult {
  hhiSector: number;
  hhiPosition: number;
  /** 1/HHI_sector — số ngành hiệu quả. */
  effSectors: number;
  /** 1/HHI_position — số vị thế hiệu quả. */
  effPositions: number;
  /** true khi vượt ngưỡng ngành HOẶC vị thế. */
  breach: boolean;
  /** Chi tiết ngưỡng nào bật. */
  breaches: string[];
}

/**
 * HHI từ danh sách tỷ trọng (0..1, tổng ≤ 1 — phần tiền mặt không tính là
 * tập trung). Mảng rỗng → 0 (không bịa — caller xử lý proxy mode).
 */
export function hhi(weights: number[]): number {
  let sum = 0;
  for (const w of weights) {
    const x = Math.max(0, w);
    sum += x * x;
  }
  return sum;
}

/** CRB-4 — HHI ngành & vị thế từ tỷ trọng (% NAV, không cần chuẩn hoá). */
export function computeConcentration(
  sectorPcts: number[],
  positionPcts: number[]
): ConcentrationResult {
  const sectorWeights = sectorPcts.map((p) => p / 100);
  const positionWeights = positionPcts.map((p) => p / 100);
  const hhiSector = hhi(sectorWeights);
  const hhiPosition = hhi(positionWeights);
  const breaches: string[] = [];
  if (hhiSector > HHI_SECTOR_THRESHOLD) {
    breaches.push(
      `HHI ngành ${hhiSector.toFixed(3).replace(".", ",")} > 0,25 (≈ ${(1 / hhiSector).toFixed(1)} ngành hiệu quả)`
    );
  }
  if (hhiPosition > HHI_POSITION_THRESHOLD) {
    breaches.push(
      `HHI vị thế ${hhiPosition.toFixed(3).replace(".", ",")} > 0,15 (≈ ${(1 / hhiPosition).toFixed(1)} vị thế hiệu quả vs mục tiêu 8)`
    );
  }
  return {
    hhiSector,
    hhiPosition,
    effSectors: hhiSector > 1e-9 ? 1 / hhiSector : 0,
    effPositions: hhiPosition > 1e-9 ? 1 / hhiPosition : 0,
    breach: breaches.length > 0,
    breaches,
  };
}

/** Kết quả CRB-5. */
export interface CorrelationResult {
  /** Tương quan TB các cặp i<j (0 khi < 2 vị thế đủ dữ liệu). */
  avgCorr: number;
  /** N_eff_bets = N / (1 + (N−1)·avgCorr). */
  effBets: number;
  /** Số vị thế vào ma trận. */
  n: number;
  /** Số cặp bị bỏ vì < 40 phiên chung THEO NGÀY. */
  pairsDropped: number;
  /** true khi avgCorr > 0,7 HOẶC N_eff_bets < N/2. */
  breach: boolean;
  note: string;
}

/** Một điểm return gắn ngày ISO ("2026-10-07") — căn mép theo NGÀY. */
export interface DatedReturn {
  date: string;
  ret: number;
}

/**
 * Pearson tương quan 2 chuỗi CÙNG ĐỘ DÀI (đã căn theo phiên chung).
 */
export function pearson(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom > 1e-12 ? Math.max(-1, Math.min(1, cov / denom)) : 0;
}

/**
 * Ghép ≤ maxN phiên CHUNG theo NGÀY của 2 chuỗi (đều tăng dần theo ngày)
 * — hai con trỏ từ CUỐI, bỏ phiên lệch (mã đình quyền/thiếu bar), giữ thứ
 * tự thời gian tăng dần ở output (Pearson bất biến với thứ tự nên giữ cho
 * rõ nghĩa). Fixbug #52-F1: ghép theo index đầu sẽ ghép return các NGÀY
 * KHÁC nhau khi 2 chuỗi dài khác nhau → tương quan sai định nghĩa.
 */
function commonSessions(
  a: DatedReturn[],
  b: DatedReturn[],
  maxN: number
): { ra: Float64Array; rb: Float64Array } {
  let i = a.length - 1;
  let j = b.length - 1;
  const pa: number[] = [];
  const pb: number[] = [];
  while (i >= 0 && j >= 0 && pa.length < maxN) {
    const da = a[i].date;
    const db = b[j].date;
    if (da === db) {
      pa.push(a[i].ret);
      pb.push(b[j].ret);
      i--;
      j--;
    } else if (da > db) {
      i--;
    } else {
      j--;
    }
  }
  return {
    ra: Float64Array.from(pa.reverse()),
    rb: Float64Array.from(pb.reverse()),
  };
}

/**
 * CRB-5 — ma trận tương quan top-15 vị thế theo MV, cửa sổ ≤ 60 PHIÊN CHUNG
 * THEO NGÀY của từng cặp (mỗi chuỗi {date, ret} tăng dần — engine xây từ
 * bar EOD). Cặp < 40 phiên chung → bỏ (nghiệm thu CRB-5.4 — không chia 0,
 * không bịa số trên phiên lệch ngày).
 */
export function computeCorrelation(
  returnsByPosition: DatedReturn[][]
): CorrelationResult {
  const n = returnsByPosition.length;
  if (n < 2) {
    return { avgCorr: 0, effBets: n, n, pairsDropped: 0, breach: false, note: "< 2 vị thế — bỏ qua đo tương quan" };
  }
  let sumCorr = 0;
  let pairCount = 0;
  let pairsDropped = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const { ra, rb } = commonSessions(returnsByPosition[i], returnsByPosition[j], CORR_WINDOW);
      if (ra.length < CORR_MIN_OVERLAP) {
        pairsDropped++;
        continue;
      }
      sumCorr += pearson(ra, rb);
      pairCount++;
    }
  }
  if (pairCount === 0) {
    return {
      avgCorr: 0,
      effBets: n,
      n,
      pairsDropped,
      breach: false,
      note: `${pairsDropped} cặp không đủ ${CORR_MIN_OVERLAP} phiên chung`,
    };
  }
  const avgCorr = sumCorr / pairCount;
  // N_eff_bets = N / (1 + (N−1)·avgCorr) — avgCorr < 0 (đa dạng hoá) →
  // mẫu số < 1 → N_eff > N: giữ nguyên N_eff_bets có thể > N (thông tin)
  const denom = 1 + (n - 1) * avgCorr;
  const effBets = denom > 1e-9 ? n / denom : n;
  const breach = avgCorr > AVG_CORR_THRESHOLD || effBets < n / 2;
  return {
    avgCorr,
    effBets,
    n,
    pairsDropped,
    breach,
    note: `danh mục ${n} vị thế thực chất là ~${effBets.toFixed(1).replace(".", ",")} cược độc lập (corr TB ${avgCorr.toFixed(2).replace(".", ",")})`,
  };
}
