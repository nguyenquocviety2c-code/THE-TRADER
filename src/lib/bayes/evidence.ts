/**
 * src/lib/bayes/evidence.ts — XÂY BỘ BẰNG CHỨNG TỪ DB (phiên #34).
 *
 * buildEvidenceBundle() đọc dữ liệu THẬT trong Supabase (90k bar EOD VNDIRECT,
 * quotes, NewsItem RSS, flows) và tính toàn bộ bằng chứng 3 bậc + tiên nghiệm
 * base-rate — deterministic, 0 LLM, ~1–2s. KHÔNG tạo side-effect mới ngoài
 * markSource của flows (idempotent, chuẩn hệ thống).
 *
 * Chu kỳ 23 agents truyền llmVotes (assessment JSON mới của LLM research +
 * risk) → được ƯU TIÊN hơn tin broadcast 24h trong DB.
 *
 * Gán tác giả bằng chứng theo đúng mối: breadth/regime → Market Analyst (A2) ·
 * z-score dải giá → Fair Value Analyst (A3) · lexicon tin → News & Sentiment
 * (A4) · flows → Liquidity Analyst (A5) · Holt → ML Forecast (A15) · đặc trưng
 * kỹ thuật → Feature Store (S2) · prior base-rate → Backtest Officer (A14).
 */

import { db } from "@/lib/db";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";
import { getForeignFlows } from "@/lib/flows";
import { latestVsMean, macd, pctChange, rsi } from "@/lib/indicators";
import { classifyRegime } from "@/lib/quant/regime";
import { holtForecastPct } from "@/lib/quant/forecast";
import { aggregateSentiment } from "@/lib/quant/sentiment";
import { historicalBaseRates, mean, zscore } from "@/lib/quant/statistics";
import { latestFeatures, loadTopSeries } from "@/lib/ml/features";
import { MLP } from "@/lib/ml/nn";
import { buildBasket, parseQTable, policyStance } from "@/lib/ml/rl";
import type {
  AgentVote,
  BayesEvidence,
  BayesVeto,
  MarketFeature,
  SectorFeature,
  SymbolEvidence,
  SymbolFeature,
  SynthesisInput,
} from "@/lib/bayes/types";
/** 5 agent LLM có phiếu assessment: 4 nghiên cứu + risk-manager. */
export const LLM_VOTE_CODES = [
  "market-analyst",
  "fair-value",
  "news-sentiment",
  "liquidity",
  "risk-manager",
] as const;

/** Phiếu LLM do chu kỳ truyền vào (assessment JSON mới nhất — ưu tiên). */
export interface LlmVoteInput {
  code: string;
  direction: "UP" | "DOWN" | "FLAT";
  confidence: number;
  evidence?: string[];
}

/** Tuỳ chọn build bundle. */
export interface BuildEvidenceOptions {
  /** Phiếu assessment của chu kỳ (nếu có — phủ dữ liệu DB 24h). */
  llmVotes?: LlmVoteInput[];
  /** Trạng thái VETO từ Ủy ban Kiểm soát của chu kỳ. */
  veto?: BayesVeto;
}

/** Số phiên lấy cho mỗi mã (base-rate 250 + biên an toàn). */
const BARS_PER_SYMBOL = 260;
/** Số phiên base-rate tiên nghiệm. */
const PRIOR_SESSIONS = 250;
/** Số mã xây bằng chứng symbol-level (top thanh khoản ADTV). */
const TOP_SYMBOL_COUNT = 10;
/** Số tin RSS tối đa chấm lexicon 24h. */
const NEWS_MAX_ITEMS = 60;

/* ─────────────────────────── Hàm chính ─────────────────────────── */

/**
 * Đọc DB + tính toàn bộ đầu vào cho synthesizeMarketAssessment().
 * Không bao giờ ném lỗi do thiếu dữ liệu — chỉ bỏ bằng chứng thiếu nền tảng.
 */
export async function buildEvidenceBundle(
  options: BuildEvidenceOptions = {}
): Promise<SynthesisInput> {
  const veto: BayesVeto = options.veto ?? { blocked: false, reason: null };
  const marketEvidence: BayesEvidence[] = [];
  const symbolEvidence: SymbolEvidence[] = [];

  /* ── 1. Quotes mới nhất toàn rổ ─────────────────────────────────────── */
  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    select: {
      id: true,
      symbol: true,
      name: true,
      sector: true,
      quotes: {
        orderBy: { tradedAt: "desc" },
        take: 1,
        select: { last: true, changePct: true, volume: true },
      },
    },
  });
  const quoted = instruments
    .map((i) => {
      const q = i.quotes[0];
      return q
        ? {
            id: i.id,
            symbol: i.symbol,
            name: i.name,
            sector: i.sector ?? "Khác",
            last: q.last,
            changePct: q.changePct,
            volume: q.volume,
          }
        : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const advancing = quoted.filter((q) => q.changePct > 0).length;
  const declining = quoted.filter((q) => q.changePct < 0).length;
  const unchanged = quoted.filter((q) => q.changePct === 0).length;
  const totalQuoted = quoted.length;
  const breadth = totalQuoted > 0 ? (advancing - declining) / totalQuoted : 0;

  /* ── 2. Chuỗi closes/volumes 260 phiên mỗi mã ────────────────────────── */
  const barLists = await Promise.all(
    quoted.map((q) =>
      db.bar
        .findMany({
          where: { instrumentId: q.id },
          orderBy: { date: "desc" },
          take: BARS_PER_SYMBOL,
          select: { close: true, volume: true },
        })
        .then((rows) => rows.reverse())
    )
  );
  const seriesBySymbol = new Map<
    string,
    { closes: number[]; volumes: number[]; quote: (typeof quoted)[number] }
  >();
  quoted.forEach((q, idx) => {
    const bars = barLists[idx];
    seriesBySymbol.set(q.symbol, { closes: bars.map((b) => b.close), volumes: bars.map((b) => b.volume), quote: q });
  });

  /* ── 3. TIÊN NGHIỆM BẬC 0 — base-rate 250 phiên thật ─────────────────── */
  const closesBySymbol = [...seriesBySymbol.values()].map((s) => s.closes);
  const baseRates = historicalBaseRates(closesBySymbol, { sessions: PRIOR_SESSIONS });
  const prior = {
    pUp: baseRates.pUp,
    pDown: baseRates.pDown,
    pFlat: baseRates.pFlat,
    baseRateNote: `Tần suất lịch sử ${PRIOR_SESSIONS} phiên: ${(baseRates.pUp * 100).toFixed(1).replace(".", ",")}% tăng / ${(baseRates.pDown * 100).toFixed(1).replace(".", ",")}% giảm / ${(baseRates.pFlat * 100).toFixed(1).replace(".", ",")}% đi ngang (${baseRates.sampleCount.toLocaleString("vi-VN")} quan sát mã×phiên)`,
  };

  /* ── 4. Bậc 1 · bằng chứng thị trường ───────────────────────────────── */

  // 4a. Breadth (tăng/giảm toàn rổ)
  if (totalQuoted >= 5 && breadth !== 0) {
    const lr = Math.min(2.2, Math.max(1, 1 + 0.6 * Math.abs(breadth)));
    marketEvidence.push({
      source: "market-breadth",
      agentName: "Market Analyst",
      gen1: "A2",
      level: "market",
      direction: breadth > 0 ? "UP" : "DOWN",
      likelihoodRatio: lr,
      weight: 0.7,
      note: `${advancing} mã tăng / ${declining} mã giảm (breadth ${(breadth >= 0 ? "+" : "") + breadth.toFixed(2)})`,
    });
  }

  // 4b. Lexicon cảm xúc tin tức 24h
  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const newsItems = await db.newsItem.findMany({
    where: { publishedAt: { gte: since24h } },
    orderBy: { publishedAt: "desc" },
    take: NEWS_MAX_ITEMS,
    select: { title: true, summary: true },
  });
  const newsAgg = aggregateSentiment(newsItems);
  if (newsItems.length > 0 && Math.abs(newsAgg.score) > 0.05) {
    const lr = Math.min(2.5, Math.exp(1.1 * Math.abs(newsAgg.score)));
    marketEvidence.push({
      source: "news-lexicon",
      agentName: "News & Sentiment",
      gen1: "A4",
      level: "market",
      direction: newsAgg.score > 0 ? "UP" : "DOWN",
      likelihoodRatio: lr,
      weight: 0.6,
      note: `Lexicon ${newsItems.length} tin 24h: score ${(newsAgg.score >= 0 ? "+" : "") + newsAgg.score.toFixed(2)} (${newsAgg.bullishCount} tăng cảm tính / ${newsAgg.bearishCount} giảm cảm tính)`,
    });
  }

  // 4c. Dòng khối ngoại ròng (flows simulated — giảm trọng số tin cậy)
  const flows = await getForeignFlows().catch(() => null);
  const flowTotal = flows ? flows.totalBuy + flows.totalSell : 0;
  if (flows && flowTotal > 0 && flows.totalNet !== 0) {
    const ratio = Math.min(1, Math.abs(flows.totalNet) / flowTotal);
    const lr = Math.min(1.8, 1 + 0.8 * ratio);
    marketEvidence.push({
      source: "foreign-flows",
      agentName: "Liquidity Analyst",
      gen1: "A5",
      level: "market",
      direction: flows.totalNet > 0 ? "UP" : "DOWN",
      likelihoodRatio: lr,
      weight: 0.5,
      note: `Khối ngoại ròng ${(flows.totalNet >= 0 ? "+" : "") + (flows.totalNet / 1e9).toFixed(1)} tỷ ₫ (${flows.mode === "live" ? "nguồn ngoài" : "mô phỏng deterministic"})`,
    });
  }

  // 4d. Holt basket forecast + regime trên rổ equal-weight
  const basketCloses = buildBasketIndex(
    [...seriesBySymbol.values()].map((s) => s.closes),
    PRIOR_SESSIONS
  );
  const basketForecast = holtForecastPct(basketCloses, { horizon: 5 });
  if (basketForecast && Math.abs(basketForecast.expectedPct) >= 0.1) {
    const strength = Math.min(1, Math.abs(basketForecast.expectedPct) / 1.5);
    const lr = Math.min(1.9, 1 + 0.9 * strength);
    marketEvidence.push({
      source: "ml-forecast.holt-basket",
      agentName: "ML Forecast",
      gen1: "A15",
      level: "market",
      direction: basketForecast.expectedPct > 0 ? "UP" : "DOWN",
      likelihoodRatio: lr,
      weight: 0.65,
      note: `Holt rổ 5 phiên: ${(basketForecast.expectedPct >= 0 ? "+" : "") + basketForecast.expectedPct.toFixed(2)}% (CI80 ${basketForecast.lowPct.toFixed(2)}%…${basketForecast.highPct.toFixed(2)}%)`,
    });
  }
  const regime = classifyRegime(basketCloses);
  if (regime.regime === "BULL_TREND" || regime.regime === "BEAR_TREND") {
    marketEvidence.push({
      source: "regime",
      agentName: "Market Analyst",
      gen1: "A2",
      level: "market",
      direction: regime.regime === "BULL_TREND" ? "UP" : "DOWN",
      likelihoodRatio: 1.5,
      weight: 0.6,
      note: `Chế độ ${regime.label} (SMA20 ${regime.sma20 != null ? Math.round(regime.sma20 * 100) / 100 : "—"} vs SMA50 ${regime.sma50 != null ? Math.round(regime.sma50 * 100) / 100 : "—"} của rổ)`,
    });
  }

  /* ── 5. Phiếu LLM (chu kỳ ưu tiên, fallback DB 24h) → evidence + votes ── */
  const votes = await resolveLlmVotes(options.llmVotes);
  const voteStats = await loadVoteAgentStats(votes.map((v) => v.code));
  // (phiên #35) Posterior Thompson sampling BanditArm — nhân vào weight phiếu:
  // agent bầu đúng hướng giá thực tế nhiều → posteriorMean cao → tin hơn.
  const banditArms =
    votes.length > 0
      ? await db.banditArm.findMany().catch(() => [])
      : [];
  const posteriorByCode = new Map(
    banditArms.map((a) => [a.agentCode, (a.alpha + 1) / (a.alpha + a.beta + 2)])
  );
  const agentVotes: AgentVote[] = [];
  for (const v of votes) {
    const roster = ROSTER_BY_CODE.get(v.code);
    const stats = voteStats.get(v.code);
    const agentName = roster?.name ?? stats?.name ?? v.code;
    const gen1 = roster?.gen1 ?? "—";
    const successRate = stats?.successRate ?? 0;
    const healthScore = stats?.healthScore ?? 80;
    const confidence = Math.max(0, Math.min(1, v.confidence));

    agentVotes.push({ code: v.code, agentName, gen1, direction: v.direction, confidence, successRate });

    // Assessment của LLM là bằng chứng thị trường (direction = quan điểm chung)
    const lr = Math.min(2.0, 1 + 0.8 * confidence);
    const firstNote = (v.evidence ?? []).filter((e) => e.trim()).slice(0, 1)[0];
    marketEvidence.push({
      source: `llm-vote:${v.code}`,
      agentName,
      gen1,
      level: "market",
      direction: v.direction,
      likelihoodRatio: lr,
      weight: Math.min(
        1,
        Math.max(0.3, (healthScore / 100) * (posteriorByCode.get(v.code) ?? 1))
      ),
      note: `${agentName} đánh giá ${v.direction === "UP" ? "TĂNG" : v.direction === "DOWN" ? "GIẢM" : "ĐI NGANG"} (tin cậy ${confidence.toFixed(2)})${firstNote ? ` — ${firstNote}` : ""}`,
    });
  }

  /* ── 6. Bậc 3 · bằng chứng symbol top ADTV ──────────────────────────── */
  const adtvBySymbol = new Map<string, number>();
  for (const [symbol, s] of seriesBySymbol) {
    const tail = s.closes.slice(-20);
    const vols = s.volumes.slice(-20);
    if (tail.length === 20) {
      adtvBySymbol.set(symbol, mean(tail.map((c, i) => c * vols[i])));
    }
  }
  const topSymbols = [...seriesBySymbol.entries()]
    .map(([symbol, s]) => ({
      symbol,
      s,
      adtv: adtvBySymbol.get(symbol) ?? 0,
    }))
    .sort((a, b) => b.adtv - a.adtv)
    .slice(0, TOP_SYMBOL_COUNT);

  const symbolFeatures: SymbolFeature[] = [];
  for (const { symbol, s } of topSymbols) {
    const closes = s.closes;
    const volumes = s.volumes;
    const last = s.quote.last || (closes.length ? closes[closes.length - 1] : 0);
    if (!last || closes.length < 30) continue;

    const rsi14 = rsi(closes, 14);
    const z90 = closes.length >= 30 ? zscore(last, closes.slice(-90)) : null;
    const macdHist = macd(closes)?.histogram ?? null;
    const volRatio = latestVsMean(volumes, 20);
    const momentum5d =
      closes.length >= 6 ? pctChange(closes[closes.length - 6], last) : null;
    const forecast = holtForecastPct(closes, { horizon: 5 });

    // 6a. RSI14 — quá bán/quá mua
    if (rsi14 != null) {
      if (rsi14 < 30) {
        symbolEvidence.push({
          source: "feature-store.rsi",
          agentName: "Feature Store",
          gen1: "S2",
          level: "symbol",
          symbol,
          direction: "UP",
          likelihoodRatio: 1.7,
          weight: 0.6,
          note: `RSI14 ${rsi14.toFixed(0)} — quá bán`,
        });
      } else if (rsi14 > 70) {
        symbolEvidence.push({
          source: "feature-store.rsi",
          agentName: "Feature Store",
          gen1: "S2",
          level: "symbol",
          symbol,
          direction: "DOWN",
          likelihoodRatio: 1.5,
          weight: 0.6,
          note: `RSI14 ${rsi14.toFixed(0)} — quá mua`,
        });
      }
    }

    // 6b. z-score dải định giá 90 phiên (A3 Fair Value)
    if (z90 != null) {
      if (z90 < -1.5) {
        symbolEvidence.push({
          source: "fair-value.zscore",
          agentName: "Fair Value Analyst",
          gen1: "A3",
          level: "symbol",
          symbol,
          direction: "UP",
          likelihoodRatio: 1.5,
          weight: 0.6,
          note: `z90 ${z90.toFixed(2)} — thấp hơn dải định giá 90 phiên`,
        });
      } else if (z90 > 1.5) {
        symbolEvidence.push({
          source: "fair-value.zscore",
          agentName: "Fair Value Analyst",
          gen1: "A3",
          level: "symbol",
          symbol,
          direction: "DOWN",
          likelihoodRatio: 1.5,
          weight: 0.6,
          note: `z90 ${z90.toFixed(2)} — cao hơn dải định giá 90 phiên`,
        });
      }
    }

    // 6c. MACD histogram
    if (macdHist != null && macdHist !== 0) {
      symbolEvidence.push({
        source: "feature-store.macd",
        agentName: "Feature Store",
        gen1: "S2",
        level: "symbol",
        symbol,
        direction: macdHist > 0 ? "UP" : "DOWN",
        likelihoodRatio: 1.25,
        weight: 0.5,
        note: `MACD histogram ${macdHist > 0 ? "dương" : "âm"} (${macdHist.toFixed(0)})`,
      });
    }

    // 6d. Khối lượng xác nhận hướng giá
    const priceDir =
      s.quote.changePct !== 0
        ? s.quote.changePct > 0
          ? "UP"
          : "DOWN"
        : momentum5d != null && momentum5d !== 0
          ? momentum5d > 0
            ? "UP"
            : "DOWN"
          : "FLAT";
    if (volRatio != null && volRatio >= 1.2 && priceDir !== "FLAT") {
      symbolEvidence.push({
        source: "feature-store.volume",
        agentName: "Feature Store",
        gen1: "S2",
        level: "symbol",
        symbol,
        direction: priceDir,
        likelihoodRatio: 1.3,
        weight: 0.55,
        note: `KL ${volRatio.toFixed(2)}× TB20 kết hợp giá ${s.quote.changePct >= 0 ? "+" : ""}${s.quote.changePct.toFixed(2)}% — dòng tiền xác nhận`,
      });
    }

    // 6e. Momentum 5 phiên
    if (momentum5d != null && Math.abs(momentum5d) > 0.3) {
      symbolEvidence.push({
        source: "feature-store.momentum",
        agentName: "Feature Store",
        gen1: "S2",
        level: "symbol",
        symbol,
        direction: momentum5d > 0 ? "UP" : "DOWN",
        likelihoodRatio: 1.2,
        weight: 0.5,
        note: `Momentum 5 phiên ${(momentum5d >= 0 ? "+" : "") + momentum5d.toFixed(2)}%`,
      });
    }

    // 6f. Holt forecast từng mã (LR theo |expected|/sigma, cap 1.8)
    if (forecast && Math.abs(forecast.expectedPct) >= 0.1) {
      const sigmaFloor = Math.max(forecast.sigmaPct, 0.05); // chống chia ~0 chuỗi phẳng
      const zStat = Math.min(1.6, Math.abs(forecast.expectedPct) / sigmaFloor);
      symbolEvidence.push({
        source: "ml-forecast.holt",
        agentName: "ML Forecast",
        gen1: "A15",
        level: "symbol",
        symbol,
        direction: forecast.expectedPct > 0 ? "UP" : "DOWN",
        likelihoodRatio: Math.min(1.8, 1 + 0.5 * zStat),
        weight: 0.6,
        note: `Holt 5 phiên ${(forecast.expectedPct >= 0 ? "+" : "") + forecast.expectedPct.toFixed(2)}% (${zStat.toFixed(1)}σ)`,
      });
    }

    symbolFeatures.push({
      symbol,
      name: s.quote.name,
      sector: s.quote.sector,
      last,
      changePct: s.quote.changePct,
      zScore: z90,
      rsi14,
      momentum5d,
      adtvVnd: adtvBySymbol.get(symbol) ?? 0,
      forecast: forecast
        ? {
            horizonDays: 5,
            expectedPct: forecast.expectedPct,
            lowPct: forecast.lowPct,
            highPct: forecast.highPct,
          }
        : null,
    });
  }

  /* ── 6g. (phiên #35) Bằng chứng học máy — MLP + Q-learning nếu có model ── */
  // 1 query findMany kind in [dl-mlp, rl-q] status serving; chưa có model
  // nào → bỏ qua im lặng (KHÔNG throw, KHÔNG log — module đọc là an toàn).
  try {
    const mlModels = await db.mlModel.findMany({
      where: { kind: { in: ["dl-mlp", "rl-q"] }, status: "serving" },
    });
    const dlModel = mlModels.find((m) => m.kind === "dl-mlp");
    const rlModel = mlModels.find((m) => m.kind === "rl-q");

    // (a) mlp-forecast: predictProba phiên cuối top-10 (featureNorm tự áp)
    if (dlModel) {
      const mlp = MLP.fromJSON(dlModel.weights);
      const feats = await latestFeatures();
      if (feats.length > 0) {
        const probs = feats.map((f) => mlp.predictProba(f.x));
        const avgUp = mean(probs.map((p) => p[0]));
        const avgDown = mean(probs.map((p) => p[2]));
        const diff = avgUp - avgDown;
        const direction: "UP" | "DOWN" | "FLAT" =
          Math.abs(diff) < 0.05 ? "FLAT" : diff > 0 ? "UP" : "DOWN";
        marketEvidence.push({
          source: "mlp-forecast (MLP 10→16→8→3)",
          agentName: "DL Trainer",
          gen1: "A17",
          level: "market",
          direction,
          likelihoodRatio: Math.min(2.0, 1 + 1.2 * Math.abs(diff)),
          weight: 0.6,
          note: `MLP v${dlModel.version} trên ${feats.length} mã: pUp ${(avgUp * 100).toFixed(1)}% / pDown ${(avgDown * 100).toFixed(1)}%`,
        });
      }
    }

    // (b) rl-policy: policyStance từ Q-table + rổ top-10 THEO QUOTE VOLUME
    // (loadTopSeries(10) — CÙNG rổ với lúc train trong /api/ml/train, để
    // stance hiển thị ở status và stance trong bằng chứng Bayes KHÔNG lệch nhau)
    if (rlModel) {
      const qTable = parseQTable(rlModel.weights);
      const rlSeries = await loadTopSeries(10);
      const basket = buildBasket(rlSeries.map((s) => s.closes));
      const stance = policyStance(qTable, basket, 0.5);
      marketEvidence.push({
        source: "rl-policy (Q-learning 48×3)",
        agentName: "RL Policy",
        gen1: "A16",
        level: "market",
        direction: stance.stance === "tăng" ? "UP" : stance.stance === "giảm" ? "DOWN" : "FLAT",
        likelihoodRatio: stance.stance === "giữ" ? 1.0 : 1.4,
        weight: 0.5,
        note: `Q-learning v${rlModel.version} khuyến nghị ${stance.stance} phơi nhiễm (exposure ${(stance.exposure * 100).toFixed(0)}%, Q-max ${stance.qMax.toFixed(2)})`,
      });
    }
  } catch {
    // mô hình hỏng/thiếu dữ liệu → im lặng bỏ qua, 4 bậc gốc không bị ảnh hưởng
  }

  /* ── 7. Bậc 2 · số liệu nền nhóm ngành (toàn rổ có quote) ───────────── */
  const sectorAgg = new Map<string, { count: number; momSum: number; momCount: number }>();
  for (const [, s] of seriesBySymbol) {
    const key = s.quote.sector;
    const agg = sectorAgg.get(key) ?? { count: 0, momSum: 0, momCount: 0 };
    agg.count++;
    if (s.closes.length >= 6) {
      const mom = pctChange(s.closes[s.closes.length - 6], s.closes[s.closes.length - 1]);
      agg.momSum += mom;
      agg.momCount++;
    }
    sectorAgg.set(key, agg);
  }
  const sectors: SectorFeature[] = [...sectorAgg.entries()]
    .map(([sector, a]) => ({
      sector,
      symbolCount: a.count,
      avgMomentum5d: a.momCount > 0 ? a.momSum / a.momCount : 0,
    }))
    .sort((a, b) => b.symbolCount - a.symbolCount);

  /* ── 8. Lồng ghép context thị trường ────────────────────────────────── */
  const market: MarketFeature = {
    advancing,
    declining,
    unchanged,
    regime: regime.label,
    netForeignFlowVnd: flows ? flows.totalNet : null,
    newsSentimentScore: newsItems.length > 0 ? newsAgg.score : null,
    breadth,
  };

  return {
    prior,
    marketEvidence,
    symbolEvidence,
    agentVotes,
    veto,
    context: {
      market,
      symbols: symbolFeatures,
      sectors,
    },
  };
}

/* ─────────────────────────── Tiện ích nội bộ ─────────────────────────── */

/** Basket index equal-weight: mỗi mã chuẩn hoá = 1 tại phiên đầu rồi lấy TB. */
function buildBasketIndex(closesBySymbol: number[][], sessions: number): number[] {
  const usable = closesBySymbol.filter((c) => c.length >= 60);
  if (usable.length === 0) return [];
  const n = Math.min(sessions, ...usable.map((c) => c.length));
  if (n < 2) return [];
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (const closes of usable) {
      const start = closes[closes.length - n];
      if (start > 0) {
        sum += closes[closes.length - n + i] / start;
        count++;
      }
    }
    index.push(count > 0 ? sum / count : 1);
  }
  return index;
}

/** Phiếu LLM: chu kỳ truyền → dùng luôn; không → đọc tin broadcast 24h. */
async function resolveLlmVotes(llmVotes?: LlmVoteInput[]): Promise<LlmVoteInput[]> {
  if (llmVotes && llmVotes.length > 0) return llmVotes;

  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const messages = await db.agentMessage.findMany({
    where: {
      broadcast: true,
      direction: "AGENT",
      createdAt: { gte: since24h },
      sentiment: { not: null },
      fromAgent: { code: { in: [...LLM_VOTE_CODES] } },
    },
    orderBy: { createdAt: "desc" },
    include: { fromAgent: { select: { code: true } } },
    take: 50,
  });
  const seen = new Set<string>();
  const votes: LlmVoteInput[] = [];
  for (const m of messages) {
    const code = m.fromAgent.code;
    if (seen.has(code)) continue; // chỉ tin MỚI NHẤT mỗi agent
    seen.add(code);
    const sentiment = (m.sentiment ?? "").toLowerCase();
    if (sentiment !== "bullish" && sentiment !== "bearish" && sentiment !== "neutral") continue;
    votes.push({
      code,
      direction: sentiment === "bullish" ? "UP" : sentiment === "bearish" ? "DOWN" : "FLAT",
      confidence: 0.6,
      evidence: [],
    });
  }
  return votes;
}

/** Thông tin vận hành của các agent có phiếu: healthScore + successRate. */
async function loadVoteAgentStats(
  codes: string[]
): Promise<Map<string, { name: string; healthScore: number; successRate: number }>> {
  if (codes.length === 0) return new Map();
  const agents = await db.agent.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, name: true, healthScore: true },
  });
  const runs = await db.agentRun.groupBy({
    by: ["agentId", "taskStatus"],
    where: { agentId: { in: agents.map((a) => a.id) } },
    _count: { _all: true },
  });
  const totalById = new Map<string, number>();
  const completedById = new Map<string, number>();
  for (const r of runs) {
    const cnt = r._count._all;
    totalById.set(r.agentId, (totalById.get(r.agentId) ?? 0) + cnt);
    if (r.taskStatus === "COMPLETED") {
      completedById.set(r.agentId, (completedById.get(r.agentId) ?? 0) + cnt);
    }
  }
  const out = new Map<string, { name: string; healthScore: number; successRate: number }>();
  for (const a of agents) {
    const total = totalById.get(a.id) ?? 0;
    const completed = completedById.get(a.id) ?? 0;
    out.set(a.code, {
      name: a.name,
      healthScore: a.healthScore,
      successRate: total > 0 ? completed / total : 0,
    });
  }
  return out;
}
