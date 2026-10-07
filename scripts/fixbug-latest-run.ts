import { db } from "../src/lib/db";
async function main() {
  const ar = await db.agentRun.findFirst({ orderBy: { startedAt: "desc" }, select: { startedAt: true, finishedAt: true, taskStatus: true } });
  const ma = await db.marketAssessment.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true, source: true, pUp: true, pDown: true, pFlat: true } });
  console.log("AgentRun mới nhất:", JSON.stringify(ar));
  console.log("Assessment mới nhất:", JSON.stringify(ma));
  console.log("Giờ hiện tại:", new Date().toISOString());
  process.exit(0);
}
main().catch((e) => { console.error("LỖI:", e instanceof Error ? e.message : String(e)); process.exit(1); });
