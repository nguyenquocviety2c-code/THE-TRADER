/**
 * prisma/backup-db.ts — SNAPSHOT DB trước db:push (MARKET_EXPANSION_BLUEPRINT B1).
 *
 * Không có pg_dump trong sandbox → dump JSON toàn bộ bảng "nhỏ" (mọi bảng trừ
 * Bar) + Bar dạng NDJSON nén nhẹ (mỗi dòng 1 bar). Khôi phục được bằng cách đọc
 * ngược file (idempotent createMany). Bar cũng re-fetch được từ dchart (B4)
 * nên đây là lớp bảo hiểm 2 tầng.
 *
 * Chạy: bun prisma/backup-db.ts <tên-thư-mục>   (mặc định db/backup-pre-b1)
 */
import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const db = new PrismaClient();

/** BigInt → chuỗi để JSON.stringify không ném (khôi phục bằng BigInt(...)). */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main() {
  const dir = process.argv[2] ?? "db/backup-pre-b1";
  await mkdir(dir, { recursive: true });

  // ── Các bảng nhỏ: dump JSON đầy đủ ──
  const dumps: Record<string, unknown[]> = {
    instrument: await db.instrument.findMany(),
    agent: await db.agent.findMany(),
    agentRun: await db.agentRun.findMany(),
    agentTask: await db.agentTask.findMany(),
    agentMessage: await db.agentMessage.findMany(),
    signal: await db.signal.findMany(),
    order: await db.order.findMany(),
    position: await db.position.findMany(),
    trade: await db.trade.findMany(),
    watchlist: await db.watchlist.findMany(),
    watchlistItem: await db.watchlistItem.findMany(),
    newsItem: await db.newsItem.findMany(),
    dataSourceStatus: await db.dataSourceStatus.findMany(),
    appSetting: await db.appSetting.findMany(),
    marketAssessment: await db.marketAssessment.findMany(),
    mlModel: await db.mlModel.findMany(),
    banditArm: await db.banditArm.findMany(),
    banditEvent: await db.banditEvent.findMany(),
    riskAlert: await db.riskAlert.findMany(),
    auditLog: await db.auditLog.findMany(),
    brokerAccount: await db.brokerAccount.findMany(),
    quote: await db.quote.findMany(),
    user: await db.user.findMany(),
  };
  for (const [table, rows] of Object.entries(dumps)) {
    await writeFile(join(dir, `${table}.json`), JSON.stringify(rows, replacer));
    console.log(`  ✓ ${table}: ${rows.length} dòng`);
  }

  // ── Bar: NDJSON từng dòng (90k+ bar, nén nhẹ bằng mảng cột) ──
  const barFile = join(dir, "bar.ndjson");
  let barCount = 0;
  const batches = await db.bar.count();
  for (let skip = 0; skip < batches || skip === 0; skip += 5000) {
    const rows = await db.bar.findMany({
      skip,
      take: 5000,
      orderBy: { id: "asc" },
      select: { id: true, instrumentId: true, date: true, open: true, high: true, low: true, close: true, volume: true },
    });
    if (rows.length === 0) break;
    const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(barFile, lines, { flag: skip === 0 ? "w" : "a" });
    barCount += rows.length;
    if (rows.length < 5000) break;
  }
  console.log(`  ✓ bar: ${barCount} dòng (NDJSON)`);

  // ── Manifest ──
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        purpose: "Backup trước db:push B1 — MARKET_EXPANSION_BLUEPRINT v1.1",
        counts: { ...Object.fromEntries(Object.entries(dumps).map(([k, v]) => [k, v.length])), bar: barCount },
        note: "Bar lưu 8 cột chính (bỏ value BigInt — re-tính được = close×volume). Khôi phục: đọc JSON/NDJSON createMany.",
      },
      null,
      2
    )
  );
  console.log(`Backup xong → ${dir}/`);
}

main()
  .catch((err) => {
    console.error("Backup THẤT BẠI:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
