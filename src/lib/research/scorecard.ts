/**
 * src/lib/research/scorecard.ts — B8 MARKET_EXPANSION_BLUEPRINT §3.6:
 * Research Council Scorecard cho 6 cử tri Hội đồng Nghiên cứu
 * (5 agent LLM + ml-forecast ensemble). THUẦN DB — 0 LLM, 0 dependencies.
 *
 * Mỗi agent một dòng:
 *  - pulls + posteriorMean   : từ BanditArm (Beta(α+1, β+1) Thompson sampling)
 *  - hit-rate                : mean(reward) trên BanditEvent ĐÃ settle (0..1)
 *  - Brier                   : mean((confidence − reward)²) trên event settled
 *                              có confidence != null (thang 0..1, thấp = tốt)
 *  - đóng góp posterior      : trung bình |Δlog-odds| của driver "llm-vote:<code>"
 *                              trong 30 MarketAssessment gần nhất (parse detail JSON)
 *  - streak                  : số event settled liên tiếp gần nhất (castAt desc)
 *                              có reward ≥ 0,5
 *  - healthScore + tên       : bảng Agent (fallback ROSTER_BY_CODE)
 *  - enoughData              : pulls ≥ 5 — false → UI "chưa đủ dữ liệu" trung thực
 *
 * Sort: hit-rate giảm dần (null coi như −1, đẩy cuối danh sách).
 */

import { db } from "@/lib/db";
import { BANDIT_ARM_CODES, ensureArms } from "@/lib/ml/bandit";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";

/** Một dòng bảng điểm trong GET /api/research/scorecard. */
export interface ScorecardRow {
  /** Slug agent — trùng BanditArm.agentCode / Agent.code. */
  code: string;
  /** Tên hiển thị (Agent.name, fallback ROSTER_BY_CODE). */
  name: string;
  /** Mã thành phần Gen-1 (A2…A15) từ agent-roster. */
  gen1: string;
  /** Số lần phiếu được kết toán reward (BanditArm.pulls). */
  pulls: number;
  /** Σ reward tích luỹ (BanditArm.wins — thập phân vì FLAT = 0,7/0,2). */
  wins: number;
  /** mean(reward) trên event đã settle — 0..1; null khi chưa có event nào. */
  hitRate: number | null;
  /** mean((confidence − reward)²) — 0..1, thấp = tốt; null khi thiếu confidence. */
  brier: number | null;
  /** Trung bình |Δlog-odds| driver "llm-vote:<code>" 30 assessment gần; null khi chưa từng vote. */
  posteriorContribution: number | null;
  /** Chuỗi event settled liên tiếp gần nhất có reward ≥ 0,5. */
  streak: number;
  /** Posterior Beta(α+1, β+1) của arm bandit — 0..1. */
  posteriorMean: number;
  /** healthScore từ bảng Agent — null khi thiếu row (fallback UI "—"). */
  healthScore: number | null;
  /** pulls ≥ 5 — ngưỡng dữ liệu tối thiểu để hiển thị đủ độ tin cậy. */
  enoughData: boolean;
}

/** Số assessment gần nhất quét cho đóng góp posterior (khớp SETTLE_SCAN_LIMIT bandit). */
const CONTRIB_SCAN_LIMIT = 30;
/** Ngưỡng pulls đủ dữ liệu (blueprint §3.6). */
const ENOUGH_DATA_PULLS = 5;
/** Ngưỡng reward tính là "đúng" khi đếm streak (FLAT khớp = 0,7 ≥ 0,5). */
const STREAK_REWARD_MIN = 0.5;

interface DriverLike {
  source?: unknown;
  deltaLogOdds?: unknown;
}

/** Parse detail JSON của MarketAssessment → mảng drivers (bỏ qua khi hỏng). */
function parseDrivers(detail: string): DriverLike[] {
  try {
    const parsed = JSON.parse(detail) as { drivers?: unknown };
    return Array.isArray(parsed.drivers) ? (parsed.drivers as DriverLike[]) : [];
  } catch {
    return [];
  }
}

/** |Δlog-odds| của driver "llm-vote:<code>" trong 1 assessment (rỗng nếu không có). */
function voteContribution(detail: string, code: string): number[] {
  return parseDrivers(detail)
    .filter((d) => d.source === `llm-vote:${code}`)
    .map((d) =>
      typeof d.deltaLogOdds === "number" && Number.isFinite(d.deltaLogOdds)
        ? Math.abs(d.deltaLogOdds)
        : NaN
    )
    .filter((n) => !Number.isNaN(n));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * Tổng hợp bảng điểm 6 agent nghiên cứu — thuần query DB (4 truy vấn nhẹ +
 * ensureArms idempotent). KHÔNG gọi LLM. Trả đủ 6 dòng kể cả khi
 * BanditEvent chưa settle (hitRate/brier null, enoughData=false).
 */
export async function buildResearchScorecard(): Promise<ScorecardRow[]> {
  const codes = [...BANDIT_ARM_CODES];

  // Idempotent — upsert 6 arm Beta(1,1) nếu DB thiếu.
  await ensureArms();

  const [arms, agentRows, settledEvents, recentAssessments] = await Promise.all([
    db.banditArm.findMany({ where: { agentCode: { in: codes } } }),
    db.agent.findMany({
      where: { code: { in: codes } },
      select: { code: true, name: true, healthScore: true },
    }),
    db.banditEvent.findMany({
      where: { agentCode: { in: codes }, settledAt: { not: null } },
      select: { agentCode: true, reward: true, confidence: true, castAt: true },
      orderBy: { castAt: "desc" },
    }),
    db.marketAssessment.findMany({
      orderBy: { createdAt: "desc" },
      take: CONTRIB_SCAN_LIMIT,
      select: { detail: true },
    }),
  ]);

  const armByCode = new Map(arms.map((a) => [a.agentCode, a]));
  const agentByCode = new Map(agentRows.map((a) => [a.code, a]));

  // Đóng góp posterior: gom |Δlog-odds| phiếu từng agent qua 30 assessment gần nhất.
  const contribByCode = new Map<string, number[]>(
    codes.map((c) => [c, [] as number[]])
  );
  for (const a of recentAssessments) {
    for (const code of codes) {
      const contribs = voteContribution(a.detail, code);
      if (contribs.length > 0) contribByCode.get(code)?.push(...contribs);
    }
  }

  const rows: ScorecardRow[] = codes.map((code) => {
    const roster = ROSTER_BY_CODE.get(code);
    const agent = agentByCode.get(code);
    const arm = armByCode.get(code);

    const pulls = arm?.pulls ?? 0;
    const wins = arm?.wins ?? 0;
    const alpha = arm?.alpha ?? 1;
    const beta = arm?.beta ?? 1;
    const posteriorMean = round4((alpha + 1) / (alpha + beta + 2));

    // Sự kiện đã settle của agent (query đã sort castAt desc).
    const rewarded = settledEvents
      .filter((e) => e.agentCode === code)
      .filter(
        (e) => typeof e.reward === "number" && Number.isFinite(e.reward)
      );
    const hitRate = mean(rewarded.map((e) => e.reward as number));

    const brierSamples = rewarded
      .filter(
        (e) => typeof e.confidence === "number" && Number.isFinite(e.confidence)
      )
      .map((e) => {
        const c = e.confidence as number;
        const r = e.reward as number;
        return (c - r) * (c - r);
      });
    const brier = mean(brierSamples);

    // Streak: đếm liên tiếp từ mới nhất lùi lại, reward ≥ 0,5.
    let streak = 0;
    for (const e of rewarded) {
      if ((e.reward as number) >= STREAK_REWARD_MIN) streak++;
      else break;
    }

    const contribs = contribByCode.get(code) ?? [];
    const posteriorContribution = mean(contribs);

    return {
      code,
      name: agent?.name ?? roster?.name ?? code,
      gen1: roster?.gen1 ?? "",
      pulls,
      wins,
      hitRate: hitRate == null ? null : round4(hitRate),
      brier: brier == null ? null : round4(brier),
      posteriorContribution:
        posteriorContribution == null ? null : round4(posteriorContribution),
      streak,
      posteriorMean,
      healthScore: agent ? agent.healthScore : null,
      enoughData: pulls >= ENOUGH_DATA_PULLS,
    };
  });

  // Sort hit-rate giảm dần — null coi như −1 (đẩy cuối, giữ nguyên thứ tự ổn định).
  rows.sort((a, b) => (b.hitRate ?? -1) - (a.hitRate ?? -1));
  return rows;
}
