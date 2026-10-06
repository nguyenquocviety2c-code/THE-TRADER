import { db } from "@/lib/db";

/**
 * Rate-limit 60s mỗi agent — DB là nguồn chân lý (PHASE3_BLUEPRINT §4.3),
 * chống spam chi phí LLM khi chạy riêng / chat liên tục.
 */

/** Chu kỳ nguội tối thiểu giữa 2 lần chạy của cùng một agent. */
const AGENT_COOLDOWN_MS = 60_000;

export type AgentRateLimit =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/**
 * Kiểm tra agent có được phép chạy ngay không:
 * (a) run mới nhất đang RUNNING → chặn;
 * (b) run mới nhất bắt đầu < 60s trước → chặn kèm số giây còn chờ;
 * còn lại → cho phép.
 */
export async function checkAgentRateLimit(agentId: string): Promise<AgentRateLimit> {
  const last = await db.agentRun.findFirst({
    where: { agentId },
    orderBy: { startedAt: "desc" },
    take: 1,
    select: { taskStatus: true, startedAt: true },
  });
  if (!last) return { ok: true };

  if (last.taskStatus === "RUNNING") {
    // Đang có tác vụ chạy — đề nghị chờ trọn chu kỳ nguội
    const elapsed = Date.now() - last.startedAt.getTime();
    const remaining = AGENT_COOLDOWN_MS - elapsed;
    return { ok: false, retryAfterSeconds: remaining > 0 ? Math.ceil(remaining / 1000) : 60 };
  }

  const delta = Date.now() - last.startedAt.getTime();
  if (delta < AGENT_COOLDOWN_MS) {
    return { ok: false, retryAfterSeconds: Math.ceil((AGENT_COOLDOWN_MS - delta) / 1000) };
  }
  return { ok: true };
}
