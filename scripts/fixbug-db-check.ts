import { db } from "../src/lib/db";

async function main() {
  const q = (s: string) => db.$queryRawUnsafe(s) as Promise<Record<string, unknown>[]>;
  const col = (r: Record<string, unknown>, ...names: string[]) => {
    for (const n of names) if (r[n] !== undefined) return r[n];
    return undefined;
  };

  const be = await q(
    'SELECT "agentCode" as code, COUNT(*) as n, COUNT("confidence") as withconf FROM "BanditEvent" GROUP BY "agentCode" ORDER BY "agentCode"'
  );
  console.log("=== BanditEvent theo arm ===");
  for (const r of be) console.log(`  ${col(r, "code")}: ${col(r, "n")} events (có confidence: ${col(r, "withconf")})`);

  const sig = await q(
    'SELECT i.symbol as sym, s.direction as dir, s.status as st, s."consensusGate" as gate, s."consensusRatio" as ratio FROM "Signal" s JOIN "Instrument" i ON s."instrumentId"=i.id ORDER BY s."createdAt" DESC LIMIT 3'
  );
  console.log("=== 3 Signal mới nhất ===");
  for (const r of sig) console.log(`  ${col(r, "sym")} ${col(r, "dir")} ${col(r, "st")} · gate=${col(r, "gate")} · ratio=${col(r, "ratio")}`);

  const ass = await q(
    `SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE detail LIKE '%"consensus":{%') as withconsensus FROM "MarketAssessment"`
  );
  console.log("MarketAssessment:", Number(col(ass[0], "total")), "· có consensus snapshot:", Number(col(ass[0], "withconsensus")), "(shadow cycles)");

  const quotes = await q(
    'SELECT i.market as mkt, COUNT(q.id) as n FROM "Quote" q JOIN "Instrument" i ON q."instrumentId"=i.id GROUP BY i.market ORDER BY i.market'
  );
  console.log("=== Quotes theo sàn ===");
  for (const r of quotes) console.log(`  ${col(r, "mkt")}: ${col(r, "n")}`);

  // BanditEvent confidence của ml-forecast (B7/B8)
  const mlBe = await q(
    `SELECT "agentCode" as code, direction, confidence, "settledAt" is not null as settled FROM "BanditEvent" WHERE "agentCode"='ml-forecast' ORDER BY "castAt" DESC LIMIT 3`
  );
  console.log("=== BanditEvent ml-forecast mới nhất ===");
  for (const r of mlBe)
    console.log(`  dir=${col(r, "direction")} conf=${col(r, "confidence")} settled=${col(r, "settled")}`);
  if ((mlBe as unknown[]).length === 0) console.log("  (chưa có event ml-forecast)");

  process.exit(0);
}

main().catch((e) => {
  console.error("LỖI:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
