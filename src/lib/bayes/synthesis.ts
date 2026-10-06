/**
 * src/lib/bayes/synthesis.ts — BỘ TỔNG HỢP BAYES THEO 3 BẬC NHÂN QUẢ (phiên #34).
 *
 * ENGINE LOG-ODDS THUẦN (không DB, deterministic — 0 LLM):
 *
 *   BẬC 0 · TIÊN NGHIỆM
 *     L_up = logit(pUp_baseRate); L_down = logit(pDown_baseRate)
 *     — base-rate đo từ tần suất thật 250 phiên toàn rổ (backtest officer A14).
 *
 *   BẬC 1 · THỊ TRƯỜNG — mỗi bằng chứng market:
 *     shift = weight × ln(LR)
 *     direction UP   → L_up += shift ; L_down −= shift
 *     direction DOWN → L_down += shift ; L_up −= shift
 *     direction FLAT → không dịch log-odds (chỉ hiện diện trong drivers)
 *     pUp = σ(L_up); pDown = σ(L_down); pFlat = max(0, 1 − pUp − pDown);
 *     chuẩn hoá 3 số cộng đúng = 1.
 *
 *   BẬC 2 · NGÀNH — sector posterior = market posterior + dịch theo momentum
 *     trung bình ngành: evidence ảo LR = exp(0.4×|mom|) cap 1.6
 *     (mom > 0 nghiêng UP, mom < 0 nghiêng DOWN).
 *
 *   BẬC 3 · CỔ PHIẾU — symbol posterior khởi từ posterior THỊ TRƯỜNG (kế thừa
 *     nhân quả), cộng thêm bằng chứng symbol-level, rồi σ + chuẩn hoá.
 *
 *   CONFIDENCE   = 1 − H(p)/ln(3)          (entropy 3 lớp chuẩn hoá)
 *   DISAGREEMENT = 1 − |Σ wᵢ·dirᵢ| / Σ wᵢ  (dir ∈ {+1,0,−1}; chỉ agentVotes)
 *   SENSITIVITY  = Δᵢ = weight × ln(LR)    (drivers sắp |Δ| giảm dần, top 12)
 *   FORECAST5D   = trung bình trọng số ADTV dự báo Holt top thanh khoản
 *
 * RÀNG BUỘC SỐ HỌC: |L| sau cộng mọi evidence ≤ 4.0 (clamp); LR ∈ [0.5, 3.0];
 * weight ∈ [0.3, 1.0].
 */

import { entropy, logit, sigmoid } from "@/lib/quant/statistics";
import type {
  BayesEvidence,
  SymbolEvidence,
  SynthesisInput,
  SynthesisOutput,
} from "@/lib/bayes/types";
import type {
  BayesDriver,
  SymbolAssessment,
} from "@/lib/types";

/* ─────────────────────────── Hằng số ràng buộc ─────────────────────────── */

/** |L| tối đa sau khi cộng mọi bằng chứng — tránh posterior 0/999. */
const LOGIT_CLAMP = 4.0;
/** LR hợp lệ ∈ [0.5, 3.0]. */
const LR_MIN = 0.5;
const LR_MAX = 3.0;
/** Weight hợp lệ ∈ [0.3, 1.0]. */
const WEIGHT_MIN = 0.3;
const WEIGHT_MAX = 1.0;
/** Bậc 2: hệ số dịch log-odds theo momentum ngành. */
const SECTOR_MOM_COEF = 0.4;
/** Bậc 2: LR bằng chứng ảo ngành tối đa 1.6 → Δ tối đa = ln(1.6). */
const SECTOR_LR_CAP = 1.6;
/** Số drivers giữ lại trong output. */
const DRIVER_TOP_N = 12;
/** Ngưỡng chênh lệch posterior để ra stance BUY/SELL. */
const STANCE_MARGIN = 0.12;

/* ─────────────────────────── Tiện ích thuần ─────────────────────────── */

/** Phần trăng dấu phẩy thập phân kiểu Việt Nam (61.2 → "61,2%"). */
function pctVi(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits).replace(".", ",")}%`;
}

/** Làm sạch 1 bằng chứng: kẹp LR/weight về biên hợp lệ; bỏ nếu vô hạn. */
function sanitizeEvidence(e: BayesEvidence): BayesEvidence | null {
  const lr = Number(e.likelihoodRatio);
  const w = Number(e.weight);
  if (!Number.isFinite(lr) || lr <= 0) return null;
  if (!Number.isFinite(w)) return null;
  return {
    ...e,
    likelihoodRatio: Math.min(LR_MAX, Math.max(LR_MIN, lr)),
    weight: Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w)),
  };
}

/** Dịch log-odds theo một bằng chứng (UP đẩy L_up lên, DOWN đẩy L_down lên). */
function shiftLogOdds(
  L: { up: number; down: number },
  e: BayesEvidence
): { up: number; down: number } {
  if (e.direction === "FLAT") return L;
  const delta = e.weight * Math.log(e.likelihoodRatio);
  if (e.direction === "UP") return { up: L.up + delta, down: L.down - delta };
  return { up: L.up - delta, down: L.down + delta };
}

/** Kẹp biên logit ±4.0. */
function clampLogits(L: { up: number; down: number }): { up: number; down: number } {
  return {
    up: Math.min(LOGIT_CLAMP, Math.max(-LOGIT_CLAMP, L.up)),
    down: Math.min(LOGIT_CLAMP, Math.max(-LOGIT_CLAMP, L.down)),
  };
}

/** Từ 2 log-odds → phân phối 3 lớp chuẩn hoá (cộng đúng 1). */
function posteriorFromLogits(L: { up: number; down: number }): {
  pUp: number;
  pDown: number;
  pFlat: number;
} {
  const pUp = sigmoid(L.up);
  const pDown = sigmoid(L.down);
  const pFlat = Math.max(0, 1 - pUp - pDown);
  const total = pUp + pDown + pFlat;
  if (total <= 0) return { pUp: 1 / 3, pDown: 1 / 3, pFlat: 1 / 3 };
  return { pUp: pUp / total, pDown: pDown / total, pFlat: pFlat / total };
}

/** Đóng góp có dấu vào L_up của một bằng chứng (dùng cho sensitivity). */
function signedDelta(e: BayesEvidence): number {
  if (e.direction === "FLAT") return 0;
  const mag = e.weight * Math.log(e.likelihoodRatio);
  return e.direction === "UP" ? mag : -mag;
}

/* ─────────────────────────── Engine chính ─────────────────────────── */

/**
 * Tổng hợp nhận định thị trường từ bundle bằng chứng — trả MarketAssessmentView
 * (id/createdAt/source/cycleRunId là placeholder; persist.ts điền giá trị DB).
 */
export function synthesizeMarketAssessment(input: SynthesisInput): SynthesisOutput {
  const marketEvidence = input.marketEvidence
    .map(sanitizeEvidence)
    .filter((e): e is BayesEvidence => e !== null);
  const symbolEvidence = input.symbolEvidence
    .map(sanitizeEvidence)
    .filter((e): e is SymbolEvidence => e !== null);

  /* ── BẬC 0 · TIÊN NGHIỆM (base-rate lịch sử 250 phiên thật) ─────────── */
  const prior = input.prior;
  let L = {
    up: logit(prior.pUp),
    down: logit(prior.pDown),
  };

  /* ── BẬC 1 · THỊ TRƯỜNG — cộng mọi bằng chứng market ────────────────── */
  for (const e of marketEvidence) {
    L = shiftLogOdds(L, e);
  }
  L = clampLogits(L);
  const marketPosterior = posteriorFromLogits(L);

  const marketDirection: SynthesisOutput["marketDirection"] =
    marketPosterior.pUp > marketPosterior.pDown && marketPosterior.pUp > marketPosterior.pFlat
      ? "BULLISH"
      : marketPosterior.pDown > marketPosterior.pUp && marketPosterior.pDown > marketPosterior.pFlat
        ? "BEARISH"
        : "NEUTRAL";

  /* ── CONFIDENCE = 1 − H(p)/ln(3) ───────────────────────────────────── */
  const rawConfidence =
    1 - entropy([marketPosterior.pUp, marketPosterior.pDown, marketPosterior.pFlat]) / Math.log(3);
  const confidence = Math.min(1, Math.max(0, rawConfidence));

  /* ── DISAGREEMENT = phân hoá phiếu có trọng số của agents ──────────── */
  let disagreement = 0;
  if (input.agentVotes.length > 0) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const v of input.agentVotes) {
      const dir = v.direction === "UP" ? 1 : v.direction === "DOWN" ? -1 : 0;
      // Trọng số phiếu = độ tự tin × độ tin cậy vận hành (successRate 0 → 0.5 mặc định)
      const w =
        Math.max(0, Math.min(1, v.confidence)) * (v.successRate > 0 ? v.successRate : 0.5);
      weightedSum += w * dir;
      totalWeight += w;
    }
    disagreement = totalWeight > 0 ? 1 - Math.abs(weightedSum) / totalWeight : 0;
  }
  disagreement = Math.min(1, Math.max(0, disagreement));

  /* ── SENSITIVITY · drivers sắp |Δ| giảm dần (top 12) ────────────────── */
  const allEvidence: BayesEvidence[] = [...marketEvidence, ...symbolEvidence];
  const drivers: BayesDriver[] = allEvidence
    .map((e) => ({
      source: e.source,
      agentName: e.agentName,
      gen1: e.gen1,
      level: e.level,
      symbol: e.level === "symbol" ? e.symbol ?? null : null,
      direction: e.direction,
      weight: Number(e.weight.toFixed(3)),
      likelihoodRatio: Number(e.likelihoodRatio.toFixed(3)),
      deltaLogOdds: Number(signedDelta(e).toFixed(4)),
      note: e.note,
    }))
    .sort((a, b) => Math.abs(b.deltaLogOdds) - Math.abs(a.deltaLogOdds))
    .slice(0, DRIVER_TOP_N);

  /* ── BẬC 2 · NGÀNH — posterior thị trường + chỉnh momentum ngành ────── */
  const sectors = input.context.sectors
    .map((s) => {
      const delta = Math.min(SECTOR_MOM_COEF * Math.abs(s.avgMomentum5d), Math.log(SECTOR_LR_CAP));
      let Ls = { ...L };
      if (s.avgMomentum5d > 0) Ls = { up: Ls.up + delta, down: Ls.down - delta };
      else if (s.avgMomentum5d < 0) Ls = { up: Ls.up - delta, down: Ls.down + delta };
      Ls = clampLogits(Ls);
      const post = posteriorFromLogits(Ls);
      const stance: "UP" | "DOWN" | "FLAT" =
        post.pUp > post.pDown && post.pUp > post.pFlat
          ? "UP"
          : post.pDown > post.pUp && post.pDown > post.pFlat
            ? "DOWN"
            : "FLAT";
      return {
        sector: s.sector,
        symbolCount: s.symbolCount,
        avgMomentum5d: Number(s.avgMomentum5d.toFixed(2)),
        pUp: Number(post.pUp.toFixed(4)),
        stance,
      };
    })
    .sort((a, b) => b.pUp - a.pUp);

  /* ── BẬC 3 · CỔ PHIẾU — kế thừa posterior thị trường + bằng chứng mã ── */
  const evidenceBySymbol = new Map<string, BayesEvidence[]>();
  for (const e of symbolEvidence) {
    const arr = evidenceBySymbol.get(e.symbol) ?? [];
    arr.push(e);
    evidenceBySymbol.set(e.symbol, arr);
  }

  const symbols: SymbolAssessment[] = input.context.symbols.map((s) => {
    const evs = evidenceBySymbol.get(s.symbol) ?? [];
    let Lsym = { ...L }; // khởi từ posterior THỊ TRƯỜNG (kế thừa nhân quả)
    for (const e of evs) {
      Lsym = shiftLogOdds(Lsym, e);
    }
    Lsym = clampLogits(Lsym);
    const post = posteriorFromLogits(Lsym);

    // STANCE: cần chênh lệch posterior đủ lớn VÀ dự báo định lượng đồng hướng
    let stance: SymbolAssessment["stance"] = "HOLD";
    if (
      post.pUp - Math.max(post.pDown, post.pFlat) >= STANCE_MARGIN &&
      (s.forecast?.expectedPct ?? 0) > 0
    ) {
      stance = "BUY";
    } else if (
      post.pDown - Math.max(post.pUp, post.pFlat) >= STANCE_MARGIN &&
      (s.forecast?.expectedPct ?? 0) < 0
    ) {
      stance = "SELL";
    }

    const symDrivers = evs
      .map((e) => ({ note: e.note, delta: Math.abs(signedDelta(e)) }))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 3)
      .map((d) => d.note);

    return {
      symbol: s.symbol,
      name: s.name,
      sector: s.sector,
      last: s.last,
      changePct: Number(s.changePct.toFixed(2)),
      pUp: Number(post.pUp.toFixed(4)),
      pDown: Number(post.pDown.toFixed(4)),
      pFlat: Number(post.pFlat.toFixed(4)),
      stance,
      zScore: s.zScore != null ? Number(s.zScore.toFixed(2)) : null,
      rsi14: s.rsi14 != null ? Number(s.rsi14.toFixed(1)) : null,
      momentum5d: s.momentum5d != null ? Number(s.momentum5d.toFixed(2)) : null,
      forecast: s.forecast
        ? {
            horizonDays: s.forecast.horizonDays,
            expectedPct: Number(s.forecast.expectedPct.toFixed(2)),
            lowPct: Number(s.forecast.lowPct.toFixed(2)),
            highPct: Number(s.forecast.highPct.toFixed(2)),
          }
        : null,
      drivers: symDrivers,
    };
  });
  // Sắp theo |pUp − pDown| giảm dần (spec MarketAssessmentView)
  symbols.sort((a, b) => Math.abs(b.pUp - b.pDown) - Math.abs(a.pUp - a.pDown));

  /* ── FORECAST5D · trung bình trọng số ADTV dự báo Holt ──────────────── */
  let forecast5d: SynthesisOutput["forecast5d"] = null;
  const forecastable = input.context.symbols.filter((s) => s.forecast && s.adtvVnd > 0);
  if (forecastable.length > 0) {
    let wSum = 0;
    let expSum = 0;
    let halfWidthSum = 0;
    for (const s of forecastable) {
      const f = s.forecast!;
      const halfWidth = (f.highPct - f.lowPct) / 2;
      wSum += s.adtvVnd;
      expSum += s.adtvVnd * f.expectedPct;
      halfWidthSum += s.adtvVnd * halfWidth;
    }
    if (wSum > 0) {
      const expectedPct = expSum / wSum;
      const halfWidth = halfWidthSum / wSum; // ≈ 1.2816 × residual trung bình × √h
      forecast5d = {
        expectedPct: Number(expectedPct.toFixed(2)),
        lowPct: Number((expectedPct - halfWidth).toFixed(2)),
        highPct: Number((expectedPct + halfWidth).toFixed(2)),
      };
    }
  }

  /* ── NARRATIVE tiếng Việt (3–5 câu, sinh từ posterior) ──────────────── */
  const narrative = buildNarrative({
    input,
    marketPosterior,
    marketDirection,
    confidence,
    disagreement,
    drivers,
    forecast5d,
    evidenceCount: allEvidence.length,
  });

  /* ── agentsConsidered: mọi agent có bằng chứng/phiếu trong lần này ──── */
  const agentNames = new Set<string>();
  for (const e of allEvidence) agentNames.add(e.agentName);
  for (const v of input.agentVotes) agentNames.add(v.agentName);
  agentNames.add("Backtest Officer"); // chủ nhân của tiên nghiệm base-rate
  const agentsConsidered = [...agentNames];

  return {
    // placeholder — saveMarketAssessment (persist.ts) điền id/createdAt thật
    id: "",
    createdAt: new Date().toISOString(),
    source: "cycle",
    cycleRunId: null,
    pUp: Number(marketPosterior.pUp.toFixed(4)),
    pDown: Number(marketPosterior.pDown.toFixed(4)),
    pFlat: Number(marketPosterior.pFlat.toFixed(4)),
    marketDirection,
    confidence: Number(confidence.toFixed(4)),
    disagreement: Number(disagreement.toFixed(4)),
    evidenceCount: allEvidence.length,
    prior: {
      pUp: Number(prior.pUp.toFixed(4)),
      pDown: Number(prior.pDown.toFixed(4)),
      pFlat: Number(prior.pFlat.toFixed(4)),
      baseRateNote: prior.baseRateNote,
    },
    drivers,
    sectors,
    symbols,
    market: {
      advancing: input.context.market.advancing,
      declining: input.context.market.declining,
      unchanged: input.context.market.unchanged,
      regime: input.context.market.regime,
      netForeignFlowVnd: input.context.market.netForeignFlowVnd,
      newsSentimentScore:
        input.context.market.newsSentimentScore != null
          ? Number(input.context.market.newsSentimentScore.toFixed(3))
          : null,
      breadth: Number(input.context.market.breadth.toFixed(3)),
    },
    forecast5d,
    veto: input.veto,
    narrative,
    agentsConsidered,
  };
}

/* ─────────────────────────── Narrative ─────────────────────────── */

interface NarrativeParts {
  input: SynthesisInput;
  marketPosterior: { pUp: number; pDown: number; pFlat: number };
  marketDirection: SynthesisOutput["marketDirection"];
  confidence: number;
  disagreement: number;
  drivers: BayesDriver[];
  forecast5d: SynthesisOutput["forecast5d"];
  evidenceCount: number;
}

/** Sinh tường thuật tiếng Việt 3–5 câu từ posterior + drivers. */
function buildNarrative(p: NarrativeParts): string {
  const dirWord =
    p.marketDirection === "BULLISH" ? "TĂNG" : p.marketDirection === "BEARISH" ? "GIẢM" : "ĐI NGANG";
  const sentences: string[] = [];

  // Câu 1 — hướng + xác suất + chế độ thị trường
  sentences.push(
    `Bộ tổng hợp Bayes trên ${p.evidenceCount} bằng chứng từ ${p.input.context.market.advancing + p.input.context.market.declining + p.input.context.market.unchanged} mã VN30: thị trường 5 phiên tới nghiêng ${dirWord} với xác suất tăng ${pctVi(p.marketPosterior.pUp)} (giảm ${pctVi(p.marketPosterior.pDown)} · đi ngang ${pctVi(p.marketPosterior.pFlat)}), chế độ ${p.input.context.market.regime.toLowerCase()}.`
  );

  // Câu 2 — 2 driver mạnh nhất kèm note
  const top2 = p.drivers.filter((d) => d.deltaLogOdds !== 0).slice(0, 2);
  if (top2.length > 0) {
    const driverText = top2
      .map(
        (d) =>
          `${d.agentName} (${d.deltaLogOdds > 0 ? "+" : ""}${d.deltaLogOdds.toFixed(2)} log-odds — ${d.note})`
      )
      .join("; ");
    sentences.push(`Hai bằng chứng mạnh nhất: ${driverText}.`);
  }

  // Câu 3 — mức bất đồng + diễn giải
  const disLevel =
    p.disagreement < 0.2
      ? "các agent rất đồng thuận"
      : p.disagreement < 0.4
        ? "các agent đồng thuận khá"
        : p.disagreement < 0.6
          ? "có bất đồng vừa phải"
          : "bất đồng cao — tín hiệu nên được đọc thận trọng";
  sentences.push(
    `Độ bất đồng agents ${pctVi(p.disagreement)} (${disLevel}); độ tin cậy mô hình ${pctVi(p.confidence)}.`
  );

  // Câu 4 — dự báo rổ 5 phiên kèm CI80
  if (p.forecast5d) {
    sentences.push(
      `Dự báo rổ 5 phiên (Holt, trọng số thanh khoản): ${p.forecast5d.expectedPct >= 0 ? "+" : ""}${p.forecast5d.expectedPct.toFixed(2).replace(".", ",")}% (khoảng tin cậy 80%: ${p.forecast5d.lowPct.toFixed(2).replace(".", ",")}% đến ${p.forecast5d.highPct.toFixed(2).replace(".", ",")}%).`
    );
  }

  // Câu 5 — cảnh báo VETO nếu bị chặn
  if (p.input.veto.blocked) {
    sentences.push(`LƯU Ý: Ủy ban Kiểm soát đang VETO — ${p.input.veto.reason ?? "ràng buộc cứng đang chặn tín hiệu mới"}.`);
  }

  return sentences.join(" ");
}
