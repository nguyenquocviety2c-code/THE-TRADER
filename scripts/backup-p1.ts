// Backup DB trước khi đổi schema P1 (nghi thức B1 #38 / practice #57)
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
const db = new PrismaClient();
const tables = ["instrument","quote","bar","agent","agentRun","agentTask","agentMessage","signal","order","position","trade","riskAlert","auditLog","watchlist","watchlistItem","newsItem","dataSourceStatus","appSetting","marketAssessment","financialFundamental","mlModel","banditArm","banditEvent","riskQuantSnapshot","corporateEvent","foreignFlow","dataQualityReport"];
const out: string[] = [];
for (const t of tables) {
  try {
    // @ts-expect-error dynamic model
    const rows = await db[t].findMany();
    out.push(`${t}: ${rows.length}`);
    writeFileSync(`db/backup-pre-p1/${t}.json`, JSON.stringify(rows, (_, v) => typeof v === "bigint" ? v.toString() : v));
  } catch { out.push(`${t}: (bỏ qua — chưa tồn tại)`); }
}
// Bar lớn — NDJOIN riêng
const bars = await db.bar.findMany({ orderBy: { instrumentId: "asc" } });
const nd = bars.map(b => `${b.instrumentId}|${b.date.toISOString()}|${b.open}|${b.high}|${b.low}|${b.close}|${b.volume}|${b.value ?? ""}`).join("\n");
writeFileSync("db/backup-pre-p1/bars.ndjson", nd);
out.push(`bar NDJSON: ${bars.length}`);
console.log(out.join("\n"));
await db.$disconnect();
