import { db } from "../src/lib/db";
async function main() {
  const ma = await db.marketAssessment.findFirst({
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, detail: true },
  });
  if (!ma) { console.log("không có assessment"); process.exit(0); }
  const d = JSON.parse(ma.detail) as Record<string, unknown>;
  const consensus = d.consensus as { ratio?: number; gate?: string; present?: number; shadow?: boolean; wouldBlock?: boolean } | undefined;
  const segments = d.segments as { segment: string; pUp: number; pDown: number }[] | undefined;
  const votes = d.agentVotes as { code: string; direction: string }[] | undefined;
  console.log("Assessment:", ma.createdAt.toISOString());
  console.log("Consensus:", JSON.stringify(consensus));
  console.log("Segments:", segments?.map((s) => `${s.segment} (${(s.pUp * 100).toFixed(0)}/${(s.pDown * 100).toFixed(0)})`).join(" · "));
  console.log("AgentVotes:", votes?.map((v) => `${v.code}:${v.direction}`).join(" · "));
  console.log("ml-forecast vote tồn tại (không đếm kép — chỉ llm-vote):", votes?.some((v) => v.code === "ml-forecast") === true);
  const ev = (d.drivers as { source: string }[] | undefined) ?? [];
  const mlSources = ev.filter((e) => e.source.includes("ml-forecast")).map((e) => e.source);
  console.log("Evidence ML sources:", mlSources.join(" | ") || "(không có)");
  process.exit(0);
}
main().catch((e) => { console.error("LỖI:", e instanceof Error ? e.message : String(e)); process.exit(1); });
