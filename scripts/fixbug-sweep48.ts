import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const q = async (sql: string) => db.$queryRawUnsafe(sql) as Promise<Record<string, unknown>[]>;
const out: string[] = [];
out.push("BAR theo sàn: " + JSON.stringify(await q(
  `SELECT i.market, COUNT(b.id)::int AS bars FROM "Bar" b JOIN "Instrument" i ON b."instrumentId"=i.id GROUP BY i.market ORDER BY bars DESC`)));
out.push("Bar giá ÂM: " + JSON.stringify(await q(
  `SELECT COUNT(*)::int c FROM "Bar" WHERE open<0 OR high<0 OR low<0 OR close<0`)));
out.push("Bar high<low: " + JSON.stringify(await q(
  `SELECT COUNT(*)::int c FROM "Bar" WHERE high<low`)));
out.push("Bar date tương lai (>2026-10-08): " + JSON.stringify(await q(
  `SELECT COUNT(*)::int c FROM "Bar" WHERE date > '2026-10-08'`)));
out.push("Bar trùng instrument+date: " + JSON.stringify(await q(
  `SELECT COUNT(*)::int c FROM (SELECT "instrumentId",date FROM "Bar" GROUP BY "instrumentId",date HAVING COUNT(*)>1) t`)));
out.push("AgentRun theo status: " + JSON.stringify(await q(
  `SELECT "taskStatus", COUNT(*)::int c FROM "AgentRun" GROUP BY "taskStatus"`)));
out.push("Bar cuối: " + JSON.stringify(await q(`SELECT MAX(date)::text d FROM "Bar"`)));
out.push("Bar US/HK: " + JSON.stringify(await q(
  `SELECT COUNT(*)::int c FROM "Bar" b JOIN "Instrument" i ON b."instrumentId"=i.id WHERE i.market IN ('US','HK')`)));
out.push("MarketAssessment: " + JSON.stringify(await q(
  `SELECT COUNT(*)::int total, SUM(CASE WHEN detail LIKE '%consensus%' THEN 1 ELSE 0 END)::int has_consensus FROM "MarketAssessment"`)));
out.push("Quotes theo sàn: " + JSON.stringify(await q(
  `SELECT i.market, COUNT(q.id)::int c FROM "Quote" q JOIN "Instrument" i ON q."instrumentId"=i.id GROUP BY i.market`)));
out.push("Signal 3 mới nhất: " + JSON.stringify(await q(
  `SELECT s."createdAt"::text t, i.symbol, s.direction, s.status FROM "Signal" s JOIN "Instrument" i ON s."instrumentId"=i.id ORDER BY s."createdAt" DESC LIMIT 3`)));
out.push("BanditEvent: " + JSON.stringify(await q(
  `SELECT "agentCode", COUNT(*)::int c FROM "BanditEvent" GROUP BY "agentCode"`)));
out.push("FinancialFundamental: " + JSON.stringify(await q(`SELECT COUNT(*)::int c FROM "FinancialFundamental"`)));
console.log(out.join("\n"));
await db.$disconnect();
