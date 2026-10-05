import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/** Vietnamese display labels for agent roles. */
export const ROLE_LABELS: Record<string, string> = {
  MARKET_ANALYST: "Phân tích thị trường",
  NEWS_SENTIMENT: "Tin tức & cảm xúc",
  RISK_MANAGER: "Quản trị rủi ro",
  PORTFOLIO_STRATEGIST: "Chiến lược danh mục",
  EXECUTION_MANAGER: "Thực thi lệnh",
};

/**
 * GET /api/agents — all 5 agents (parsed config, pending tasks, last run)
 * plus the 12 most recent tasks across agents.
 */
export async function GET() {
  try {
    const [agents, tasks, pendingCounts, lastRuns] = await Promise.all([
      db.agent.findMany({
        orderBy: { createdAt: "asc" },
      }),
      db.agentTask.findMany({
        orderBy: { createdAt: "desc" },
        take: 12,
        include: { agent: { select: { code: true, name: true } } },
      }),
      db.agentTask.groupBy({
        by: ["agentId"],
        where: { status: { in: ["PENDING", "RUNNING"] } },
        _count: { _all: true },
      }),
      db.agentRun.findMany({
        orderBy: { startedAt: "desc" },
        take: 50,
        select: {
          agentId: true,
          taskStatus: true,
          startedAt: true,
          durationMs: true,
          tokensIn: true,
          tokensOut: true,
          costUsd: true,
        },
      }),
    ]);

    // First (latest) run per agent — lastRuns are already desc by startedAt
    const lastRunByAgent = new Map<string, (typeof lastRuns)[number]>();
    for (const run of lastRuns) {
      if (!lastRunByAgent.has(run.agentId)) lastRunByAgent.set(run.agentId, run);
    }
    const pendingByAgent = new Map(
      pendingCounts.map((c) => [c.agentId, c._count._all])
    );

    return NextResponse.json(
      toPlain({
        agents: agents.map((a) => {
          let config: Record<string, unknown> | null = null;
          try {
            config = a.config ? (JSON.parse(a.config) as Record<string, unknown>) : null;
          } catch {
            config = null;
          }
          const lr = lastRunByAgent.get(a.id) ?? null;
          return {
            id: a.id,
            code: a.code,
            name: a.name,
            role: a.role,
            roleLabel: ROLE_LABELS[a.role] ?? a.role,
            description: a.description,
            model: a.model,
            status: a.status,
            healthScore: a.healthScore,
            lastRunAt: a.lastRunAt,
            config,
            pendingTaskCount: pendingByAgent.get(a.id) ?? 0,
            lastRun: lr
              ? {
                  taskStatus: lr.taskStatus,
                  startedAt: lr.startedAt,
                  durationMs: lr.durationMs,
                  tokensIn: lr.tokensIn,
                  tokensOut: lr.tokensOut,
                  costUsd: lr.costUsd,
                }
              : null,
          };
        }),
        tasks: tasks.map((t) => ({
          id: t.id,
          agentCode: t.agent.code,
          agentName: t.agent.name,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          createdAt: t.createdAt,
        })),
      })
    );
  } catch (err) {
    console.error("[api/agents]", err);
    return NextResponse.json(
      { error: "Không tải được dữ liệu agent." },
      { status: 500 }
    );
  }
}
