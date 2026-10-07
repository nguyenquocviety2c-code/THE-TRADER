/**
 * src/lib/ml/bandit.ts — THOMPSON SAMPLING Beta-Bernoulli cho 5 arm =
 * 5 LLM research agents (phiên #35). KHÔNG gọi LLM, KHÔNG dependencies.
 *
 * Posterior Beta(α+1, β+1) mỗi arm; reward sinh từ kết toán phiếu bầu:
 * đối chiếu direction vote trong MarketAssessment với realized direction
 * của rổ top-10 sau 5 NGÀY GIAO DỊCH (ngưỡng ±0,5%): đúng hướng → 1,
 * sai → 0; vote FLAT & realized FLAT → 0,7; vote FLAT & khác → 0,2.
 * Alpha += reward, beta += (1 − reward) — chuẩn Beta-Bernoulli conjugate.
 *
 * Ban đầu chu kỳ mới chạy → chưa đủ 5 phiên → settle 0 (trung thực);
 * reward tự kết toán khi bar EOD mới về (settlePendingRewards được gọi
 * trước mỗi lần train + trong chu kỳ rl-trainer).
 */

import { db } from "@/lib/db";
import { ROSTER_BY_CODE } from "@/lib/agent-roster";

/** 5 arm Thompson sampling = 5 agent LLM có phiếu assessment. */
export const BANDIT_ARM_CODES = [
  "market-analyst",
  "fair-value",
  "news-sentiment",
  "liquidity",
  "risk-manager",
] as const;

/** Số phiên chờ trước khi kết toán reward. */
const SETTLE_SESSIONS = 5;
/** Ngưỡng realized direction của rổ (±0,5%). */
const SETTLE_THRESHOLD = 0.005;
/** Số mã tối thiểu có giá tại 2 mốc thời gian để kết toán. */
const SETTLE_MIN_SYMBOLS = 3;
/** Quét N assessment gần nhất khi kết toán (phiếu cũ hơn coi như bỏ quên). */
const SETTLE_SCAN_LIMIT = 30;

/** Phiếu bầu của một agent trong assessment. */
interface CastVote {
  code: string;
  direction: "UP" | "DOWN" | "FLAT";
}

/** Kết quả một lần kết toán. */
export interface SettleResult {
  /** Số assessment đủ 5 phiên tuổi được kết toán trong lần gọi này. */
  settled: number;
  /** Tổng số phiếu được kết toán (reward đã ghi). */
  votes: number;
  /** Chi tiết từng phiếu (narrative cho runner rl-trainer). */
  details?: { agentCode: string; agentName: string; reward: number; assessmentId: string }[];
}

/** Upsert 5 BanditArm nếu thiếu (idempotent — gọi an toàn mọi nơi). */
export async function ensureArms(): Promise<void> {
  for (const code of BANDIT_ARM_CODES) {
    await db.banditArm.upsert({
      where: { agentCode: code },
      update: {},
      create: { agentCode: code, alpha: 1, beta: 1, pulls: 0, wins: 0 },
    });
  }
}

/**
 * Đọc phiếu bầu từ detail JSON của assessment: hỗ trợ cả dạng detail
 * .agentVotes [{code, direction}] và dạng .drivers source "llm-vote:<code>"
 * (cấu trúc thực tế đang lưu) — chỉ giữ 5 arm bandit.
 */
function parseVotes(detail: string): CastVote[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: CastVote[] = [];
  const isDir = (d: unknown): d is CastVote["direction"] =>
    d === "UP" || d === "DOWN" || d === "FLAT";

  const votes = parsed.agentVotes;
  if (Array.isArray(votes)) {
    for (const v of votes) {
      const row = v as { code?: unknown; direction?: unknown };
      if (typeof row.code === "string" && isDir(row.direction)) {
        out.push({ code: row.code, direction: row.direction });
      }
    }
    return filterArms(out);
  }
  const drivers = parsed.drivers;
  if (Array.isArray(drivers)) {
    for (const d of drivers) {
      const row = d as { source?: unknown; direction?: unknown };
      if (
        typeof row.source === "string" &&
        row.source.startsWith("llm-vote:") &&
        isDir(row.direction)
      ) {
        out.push({ code: row.source.slice("llm-vote:".length), direction: row.direction });
      }
    }
  }
  return filterArms(out);
}

/** Chỉ giữ phiếu của 5 arm bandit. */
function filterArms(votes: CastVote[]): CastVote[] {
  const armSet = new Set<string>(BANDIT_ARM_CODES);
  return votes.filter((v) => armSet.has(v.code));
}

/**
 * Kết toán mọi phiếu chờ: với mỗi assessment (30 bản gần nhất) chưa có
 * BanditEvent settled mà đã đủ 5 ngày giao dịch tính từ createdAt → tính
 * realized direction rổ top-10 → reward từng phiếu → upsert BanditEvent +
 * cập nhật alpha/beta/pulls/wins BanditArm. Trả {settled, votes, details}.
 */
export async function settlePendingRewards(): Promise<SettleResult> {
  await ensureArms();

  const assessments = await db.marketAssessment.findMany({
    orderBy: { createdAt: "desc" },
    take: SETTLE_SCAN_LIMIT,
    select: { id: true, createdAt: true, detail: true },
  });
  if (assessments.length === 0) return { settled: 0, votes: 0 };

  // Phiếu đã settle (assessmentId:agentCode) — bỏ qua khi quét
  const events = await db.banditEvent.findMany({
    where: { assessmentId: { in: assessments.map((a) => a.id) } },
    select: { assessmentId: true, agentCode: true, settledAt: true },
  });
  const settledKeys = new Set(
    events
      .filter((e) => e.settledAt != null)
      .map((e) => `${e.assessmentId}:${e.agentCode}`)
  );

  // Chỉ assessment còn phiếu chờ mới cần bar
  const pending = assessments.filter((a) => {
    const votes = parseVotes(a.detail);
    return votes.some((v) => !settledKeys.has(`${a.id}:${v.code}`));
  });
  if (pending.length === 0) return { settled: 0, votes: 0 };

  // 1 truy vấn distinct date mỗi chiều: đủ phiên cho mọi assessment trong quét
  const oldest = pending.reduce(
    (min, a) => (a.createdAt < min ? a.createdAt : min),
    pending[0].createdAt
  );
  const futureDates = await db.bar.findMany({
    where: { date: { gte: oldest } },
    distinct: ["date"],
    orderBy: { date: "asc" },
    take: SETTLE_SESSIONS * SETTLE_SCAN_LIMIT + 20,
    select: { date: true },
  });
  // Phiên cast của mỗi assessment = phiên giao dịch cuối tại/b trước khi bầu
  // (danh sách distinct desc — đủ cho 30 assessment trong quét)
  const pastDates = await db.bar.findMany({
    where: { date: { lte: pending[0].createdAt } },
    distinct: ["date"],
    orderBy: { date: "desc" },
    take: SETTLE_SCAN_LIMIT,
    select: { date: true },
  });

  // Rổ top-10 thanh khoản theo quote volume mới nhất
  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    select: {
      id: true,
      quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { volume: true } },
    },
  });
  const topIds = instruments
    .map((i) => (i.quotes[0] ? { id: i.id, volume: i.quotes[0].volume } : null))
    .filter((r): r is { id: string; volume: number } => r !== null)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 10)
    .map((r) => r.id);

  let settled = 0;
  let votes = 0;
  const details: NonNullable<SettleResult["details"]> = [];

  for (const a of pending) {
    const votesForAssessment = parseVotes(a.detail).filter(
      (v) => !settledKeys.has(`${a.id}:${v.code}`)
    );
    if (votesForAssessment.length === 0) continue;

    // Đủ 5 phiên giao dịch sau createdAt chưa?
    const after = futureDates.filter((f) => f.date >= a.createdAt).slice(0, SETTLE_SESSIONS);
    const castDate = pastDates.find((d) => d.date <= a.createdAt)?.date;
    if (after.length < SETTLE_SESSIONS || castDate == null) continue;
    const realizedDate = after[SETTLE_SESSIONS - 1].date;

    // Realized direction rổ top-10: equal-weight ret mỗi mã cast → realized
    const bars = await db.bar.findMany({
      where: { instrumentId: { in: topIds }, date: { in: [castDate, realizedDate] } },
      select: { instrumentId: true, date: true, close: true },
    });
    const byInstrument = new Map<string, { cast?: number; realized?: number }>();
    for (const b of bars) {
      const entry = byInstrument.get(b.instrumentId) ?? {};
      if (b.date.getTime() === castDate.getTime()) entry.cast = b.close;
      if (b.date.getTime() === realizedDate.getTime()) entry.realized = b.close;
      byInstrument.set(b.instrumentId, entry);
    }
    const rets: number[] = [];
    for (const e of byInstrument.values()) {
      if (e.cast != null && e.realized != null && e.cast > 0) {
        rets.push(e.realized / e.cast - 1);
      }
    }
    if (rets.length < SETTLE_MIN_SYMBOLS) continue; // dữ liệu thưa — hoãn
    const basketRet = rets.reduce((s, r) => s + r, 0) / rets.length;
    const realizedDir: CastVote["direction"] =
      basketRet > SETTLE_THRESHOLD ? "UP" : basketRet < -SETTLE_THRESHOLD ? "DOWN" : "FLAT";

    // Reward từng phiếu theo quy ước Thompson sampling
    for (const v of votesForAssessment) {
      let reward: number;
      if (v.direction === "FLAT") reward = realizedDir === "FLAT" ? 0.7 : 0.2;
      else reward = v.direction === realizedDir ? 1 : 0;

      await db.banditEvent.upsert({
        where: { assessmentId_agentCode: { assessmentId: a.id, agentCode: v.code } },
        update: { settledAt: new Date(), reward, direction: v.direction },
        create: {
          assessmentId: a.id,
          agentCode: v.code,
          direction: v.direction,
          castAt: a.createdAt,
          settledAt: new Date(),
          reward,
        },
      });
      await db.banditArm.update({
        where: { agentCode: v.code },
        data: {
          alpha: { increment: reward },
          beta: { increment: 1 - reward },
          pulls: { increment: 1 },
          wins: { increment: reward },
          lastRewardAt: new Date(),
        },
      });
      const roster = ROSTER_BY_CODE.get(v.code);
      details.push({
        agentCode: v.code,
        agentName: roster?.name ?? v.code,
        reward,
        assessmentId: a.id,
      });
      votes++;
    }
    settled++;
  }

  return { settled, votes, details };
}

/** Ảnh chụp posterior các arm (sắp theo posteriorMean giảm dần) + lần settle cuối. */
export async function banditSnapshot(): Promise<{
  arms: {
    agentCode: string;
    name: string;
    alpha: number;
    beta: number;
    pulls: number;
    wins: number;
    posteriorMean: number;
  }[];
  lastSettleAt: Date | null;
}> {
  await ensureArms();
  const arms = await db.banditArm.findMany();
  const agg = await db.banditEvent.aggregate({ _max: { settledAt: true } });
  const mapped = arms.map((a) => {
    const roster = ROSTER_BY_CODE.get(a.agentCode);
    return {
      agentCode: a.agentCode,
      name: roster?.name ?? a.agentCode,
      alpha: a.alpha,
      beta: a.beta,
      pulls: a.pulls,
      wins: a.wins,
      posteriorMean: Number(((a.alpha + 1) / (a.alpha + a.beta + 2)).toFixed(4)),
    };
  });
  mapped.sort((x, y) => y.posteriorMean - x.posteriorMean);
  return { arms: mapped, lastSettleAt: agg._max.settledAt };
}

/** Số phiếu bầu LLM chờ tới phiên thứ 5 (chưa settle) — 30 assessment gần nhất. */
export async function pendingSettleCount(): Promise<number> {
  const assessments = await db.marketAssessment.findMany({
    orderBy: { createdAt: "desc" },
    take: SETTLE_SCAN_LIMIT,
    select: { id: true, detail: true },
  });
  if (assessments.length === 0) return 0;
  const events = await db.banditEvent.findMany({
    where: { assessmentId: { in: assessments.map((a) => a.id) } },
    select: { assessmentId: true, agentCode: true, settledAt: true },
  });
  const settledKeys = new Set(
    events
      .filter((e) => e.settledAt != null)
      .map((e) => `${e.assessmentId}:${e.agentCode}`)
  );
  let pending = 0;
  for (const a of assessments) {
    for (const v of parseVotes(a.detail)) {
      if (!settledKeys.has(`${a.id}:${v.code}`)) pending++;
    }
  }
  return pending;
}
