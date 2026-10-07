/**
 * src/lib/risk/sizing.ts — CRB-9 · FRACTIONAL KELLY (¼-KELLY) — TƯ VẤN
 * BET SIZING (CONTROL_RISK_QUANT_BLUEPRINT v1.1 §6).
 *
 *   p = Σᵢ (wᵢ · posteriorMeanᵢ) / Σᵢ wᵢ  — trung bình TRỌNG SỐ posterior
 *       Beta của các cử tri ĐỒNG HƯỚNG tín hiệu (wᵢ = trọng số consensus
 *       bandit, có sẵn); không cử tri nào đồng hướng → p = 0,5 (không biết —
 *       trung tính). [Ghi chú kiến trúc: công thức §6 là tổng có trọng số;
 *       với > 2 cử tri đồng hướng tổng dễ vượt 1 → chuẩn hoá theo Σwᵢ để p
 *       luôn ∈ (0 · 1) — đúng nghĩa xác suất, nghiệm thu (2) p=0,7 khả thi.]
 *   b = (targetPrice − entry)/(entry − stopLoss)   (BUY; SELL đảo dấu — b ≤ 0 → skip)
 *   f* = (b·p − (1−p))/b                            (Kelly đầy đủ)
 *   f  = clamp(f* × 1/4, 0, dynMaxPositionPct/100) (¼-Kelly + chặn hạn mức động)
 *
 * TUYỆT ĐỐI THAM MƯU: f chỉ xuất hiện trong signal.rationale của Chủ tịch
 * + UI — KHÔNG tự động đặt khối lượng lệnh (trader phê duyệt A8 vẫn giữ).
 */

/** Phân số Kelly (¼ — fractional, giảm variance). */
export const KELLY_FRACTION = 0.25;
/** p trung tính khi không có cử tri đồng hướng. */
export const KELLY_NEUTRAL_P = 0.5;
/** Kẹp p vào dải an toàn tránh odds 0/∞. */
const P_FLOOR = 0.05;
const P_CEIL = 0.95;

/** Posterior một cử tri (từ banditSnapshot — có sẵn trong chu kỳ). */
export interface CouncilArm {
  agentCode: string;
  /** Trọng số consensus wᵢ ∈ [0,3 · 1] (clamp health × posterior — B9). */
  weight: number;
  /** PosteriorMean Beta(α+1, β+1) của arm. */
  posteriorMean: number;
}

/** Phiếu bầu hiện tại của một cử tri. */
export interface CouncilVote {
  code: string;
  direction: "UP" | "DOWN" | "FLAT";
}

/**
 * p = trung bình trọng số posterior các cử tri ĐỒNG HƯỚNG direction
 * (BUY→UP · SELL→DOWN). Không cử tri đồng hướng → 0,5 (trung tính).
 */
export function alignedCouncilP(
  arms: CouncilArm[],
  votes: CouncilVote[],
  direction: "UP" | "DOWN"
): number {
  const alignedCodes = new Set(
    votes.filter((v) => v.direction === direction).map((v) => v.code)
  );
  let wSum = 0;
  let pSum = 0;
  for (const arm of arms) {
    if (!alignedCodes.has(arm.agentCode)) continue;
    const w = Math.max(0.3, Math.min(1, arm.weight));
    wSum += w;
    pSum += w * Math.max(0, Math.min(1, arm.posteriorMean));
  }
  if (wSum <= 0) return KELLY_NEUTRAL_P;
  return Math.max(P_FLOOR, Math.min(P_CEIL, pSum / wSum));
}

/** Kết quả Kelly cho MỘT tín hiệu. */
export interface KellyHint {
  /** Tỷ trọng gợi ý f (thập phân của NAV — 0,10 = 10% NAV). */
  f: number;
  /** p hội đồng đồng hướng đã dùng. */
  p: number;
  /** Tỷ lệ thưởng:rủi b đã dùng. */
  b: number;
  /** true khi b ≤ 0 (target ≤ entry hoặc thiếu stop) — KHÔNG gợi ý. */
  skipped: boolean;
  /** Ghi chú 1 dòng để nhúng rationale (tiếng Việt). */
  note: string;
}

/**
 * CRB-9 — ¼-Kelly cho tín hiệu BUY/SELL.
 * entry: giá hiện tại mã tín hiệu (giá close/quote mới nhất); thiếu
 * targetPrice/stopLoss hoặc b ≤ 0 → skip (nghiệm thu CRB-9.4: log, không
 * gợi ý). f bị chặn trên bởi hạn mức vị thế ĐỘNG (CRB-1×CRB-7).
 */
export function fractionalKelly(input: {
  direction: "BUY" | "SELL";
  entry: number;
  targetPrice: number | null;
  stopLoss: number | null;
  p: number;
  /** Hạn mức vị thế động (% NAV — dynMaxPositionPct). */
  dynMaxPositionPct: number;
}): KellyHint {
  const { direction, entry, targetPrice, stopLoss, p, dynMaxPositionPct } = input;
  const neutral: KellyHint = {
    f: 0,
    p,
    b: 0,
    skipped: true,
    note: "Kelly ¼ bỏ qua — thiếu target/stop hợp lệ hoặc tỷ lệ thưởng:rủi ≤ 0.",
  };
  if (
    !(entry > 0) ||
    targetPrice == null ||
    stopLoss == null ||
    !(stopLoss > 0) ||
    !(targetPrice > 0)
  ) {
    return neutral;
  }
  let b: number;
  if (direction === "BUY") {
    const denom = entry - stopLoss;
    if (denom <= 0) return neutral;
    b = (targetPrice - entry) / denom;
  } else {
    // SELL đảo dấu: thưởng = entry − target, rủi = stop − entry
    const denom = stopLoss - entry;
    if (denom <= 0) return neutral;
    b = (entry - targetPrice) / denom;
  }
  if (b <= 0) return neutral;

  const fFull = (b * p - (1 - p)) / b;
  const maxF = Math.max(0, dynMaxPositionPct / 100);
  const f = Math.min(maxF, Math.max(0, fFull * KELLY_FRACTION));
  return {
    f,
    p,
    b,
    skipped: false,
    note: `Kelly ¼ gợi ý tỷ trọng tối đa ${(f * 100).toFixed(1).replace(".", ",")}% NAV cho tín hiệu này — căn cứ bandit posterior của các cử tri đồng hướng (p ${(p * 100).toFixed(0)}%, thưởng:rủi ${b.toFixed(1).replace(".", ",")}:1, chặn hạn mức động ${(maxF * 100).toFixed(1).replace(".", ",")}%). Chỉ mang tính tham mưu — khối lượng lệnh do trader phê duyệt.`,
  };
}
