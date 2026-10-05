import { db } from "@/lib/db";

/**
 * Dynamic health scoring (TECHNICAL_BLUEPRINT §5.3).
 *
 * - FAILED run           → −12
 * - COMPLETED run        → +2
 * - durationMs < P50 of prior COMPLETED runs → additional +1
 * - Clamped to [0, 100]
 *
 * Called after every AgentRun so `Agent.healthScore` reflects real telemetry.
 */
export async function updateAgentHealth(
  agentId: string,
  success: boolean,
  durationMs: number | null
): Promise<number> {
  const [agent, priorRuns] = await Promise.all([
    db.agent.findUnique({
      where: { id: agentId },
      select: { healthScore: true },
    }),
    db.agentRun.findMany({
      where: { agentId, taskStatus: "COMPLETED" },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: { durationMs: true },
    }),
  ]);
  if (!agent) return 0;

  let delta = success ? 2 : -12;

  if (success && durationMs != null && priorRuns.length >= 3) {
    const durations = priorRuns
      .map((r) => r.durationMs)
      .filter((d): d is number => d != null)
      .sort((a, b) => a - b);
    if (durations.length >= 3) {
      const mid = Math.floor(durations.length / 2);
      const p50 =
        durations.length % 2 === 0
          ? (durations[mid - 1] + durations[mid]) / 2
          : durations[mid];
      if (durationMs < p50) delta += 1;
    }
  }

  const next = Math.max(0, Math.min(100, agent.healthScore + delta));
  if (next !== agent.healthScore) {
    await db.agent.update({
      where: { id: agentId },
      data: { healthScore: next },
    });
  }
  return next;
}
