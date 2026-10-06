import { db } from "@/lib/db";

/**
 * Rate-limit 60s mỗi agent — DB là nguồn chân lý (PHASE3_BLUEPRINT §4.3),
 * chống spam chi phí LLM khi chạy riêng / chat liên tục.
 */

/** Chu kỳ nguội tối thiểu giữa 2 lần chạy của cùng một agent. */
const AGENT_COOLDOWN_MS = 60_000;

/**
 * Ngưỡng coi một run RUNNING là "kẹt" (process crash/restart giữa chừng,
 * outer catch không chạy). Giữ > 2× timeout LLM (45s) + biên độ retry.
 */
const STALE_RUNNING_MS = 5 * 60_000;

export type AgentRateLimit =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/**
 * Dọn run kẹt RUNNING (audit AUD-CODE #5): AgentRun RUNNING quá 5 phút →
 * FAILED (lỗi "stale"), agent tương ứng đưa về IDLE nếu không có run sống
 * mới hơn. Trả về số run đã dọn. Idempotent — gọi thoải mái mỗi request.
 */
export async function reapStaleAgentRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
  try {
    const reaped = await db.agentRun.updateMany({
      where: { taskStatus: "RUNNING", startedAt: { lt: cutoff } },
      data: { taskStatus: "FAILED", finishedAt: new Date(), error: "Run kẹt RUNNING ( watchdog dọn sau 5 phút — process có thể đã restart giữa chừng)." },
    });
    if (reaped.count === 0) return 0;
    // Agent kẹt trạng thái RUNNING nhưng không còn run sống → trả về IDLE
    await db.agent.updateMany({
      where: {
        status: "RUNNING",
        runs: { none: { taskStatus: "RUNNING" } },
      },
      data: { status: "IDLE" },
    });
    return reaped.count;
  } catch {
    return 0; // không chặn luồng chính vì watchdog
  }
}

/**
 * Kiểm tra agent có được phép chạy ngay không:
 * (a) run mới nhất đang RUNNING (và còn "sống" < 5 phút) → chặn;
 * (b) run mới nhất bắt đầu < 60s sau run trước → chặn kèm số giây còn chờ;
 * còn lại → cho phép. Run RUNNING kẹt quá 5 phút tự động được dọn + cho phép.
 */
export async function checkAgentRateLimit(agentId: string): Promise<AgentRateLimit> {
  const last = await db.agentRun.findFirst({
    where: { agentId },
    orderBy: { startedAt: "desc" },
    take: 1,
    select: { id: true, taskStatus: true, startedAt: true },
  });
  if (!last) return { ok: true };

  if (last.taskStatus === "RUNNING") {
    const elapsed = Date.now() - last.startedAt.getTime();
    if (elapsed > STALE_RUNNING_MS) {
      // Watchdog inline: run này đã chết âm thầm — dọn rồi cho phép chạy lại
      await db.agentRun
        .updateMany({
          where: { id: last.id, taskStatus: "RUNNING" },
          data: { taskStatus: "FAILED", finishedAt: new Date(), error: "Run kẹt RUNNING (watchdog dọn sau 5 phút)." },
        })
        .catch(() => undefined);
      await db.agent
        .updateMany({
          where: { id: agentId, status: "RUNNING" },
          data: { status: "IDLE" },
        })
        .catch(() => undefined);
      return { ok: true };
    }
    // Đang có tác vụ chạy thật — đề nghị chờ trọn chu kỳ nguội
    const remaining = AGENT_COOLDOWN_MS - elapsed;
    return { ok: false, retryAfterSeconds: remaining > 0 ? Math.ceil(remaining / 1000) : 60 };
  }

  const delta = Date.now() - last.startedAt.getTime();
  if (delta < AGENT_COOLDOWN_MS) {
    return { ok: false, retryAfterSeconds: Math.ceil((AGENT_COOLDOWN_MS - delta) / 1000) };
  }
  return { ok: true };
}
