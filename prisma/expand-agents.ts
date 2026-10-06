/**
 * prisma/expand-agents.ts — mở rộng đội 5 → 23 agents trong Supabase.
 *
 * Upsert theo `code` từ nguồn duy nhất src/lib/agent-roster.ts:
 *  - agent mới: tạo đầy đủ (code/name/role/group/description/config/model)
 *  - agent cũ (5 pipeline): cập nhật group + model mặc định space-bunny-free
 *    + description/config đồng bộ roster — KHÔNG đụng runs/messages/
 *    signals/health/status (giữ nguyên lịch sử vận hành).
 *
 * Chạy: bun prisma/expand-agents.ts   (idempotent — chạy lại không hại)
 */
import { PrismaClient } from "@prisma/client";
import { AGENT_ROSTER } from "../src/lib/agent-roster";

const db = new PrismaClient();

async function main() {
  const existing = await db.agent.findMany({
    select: { id: true, code: true, status: true },
  });
  const byCode = new Map(existing.map((a) => [a.code, a]));

  let created = 0;
  let updated = 0;

  for (const entry of AGENT_ROSTER) {
    const found = byCode.get(entry.code);
    if (!found) {
      await db.agent.create({
        data: {
          code: entry.code,
          name: entry.name,
          role: entry.role as never, // enum AgentRole — giá trị đã khớp roster
          group: entry.group,
          description: entry.description,
          model: "space-bunny-free",
          status: "IDLE",
          config: JSON.stringify(entry.config),
        },
      });
      created++;
      console.log(`+ TẠO   ${entry.code.padEnd(22)} [${entry.group}/${entry.kind}] ${entry.gen1}`);
    } else {
      await db.agent.update({
        where: { id: found.id },
        data: {
          name: entry.name,
          role: entry.role as never,
          group: entry.group,
          description: entry.description,
          model: "space-bunny-free",
          config: JSON.stringify(entry.config),
          // KHÔNG đụng: status, healthScore, lastRunAt
        },
      });
      updated++;
      console.log(`~ CẬP NHẬT ${entry.code.padEnd(22)} [${entry.group}/${entry.kind}] ${entry.gen1}`);
    }
  }

  // Tránh các agent kẹt RUNNING từ lần restart trước
  const unstuck = await db.agent.updateMany({
    where: { status: "RUNNING" },
    data: { status: "IDLE" },
  });

  const total = await db.agent.count();
  console.log(`\nKết quả: tạo ${created} · cập nhật ${updated} · reset RUNNING→IDLE ${unstuck.count} · tổng ${total} agents`);

  if (total !== AGENT_ROSTER.length) {
    throw new Error(`Kỳ vọng ${AGENT_ROSTER.length} agents nhưng DB có ${total} — kiểm tra agents thừa (code ngoài roster).`);
  }
}

main()
  .catch((err) => {
    console.error("LỖI expand-agents:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
