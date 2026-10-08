/** Kiểm định Fixbug #59 — lớp dữ liệu tĩnh: bar date determinism + duplicates. */
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

async function main() {
  // 1. Bar trùng nhau cùng phần-ngày (sẽ làm return sai & gap-check nhiễu)
  const dup = await db.$queryRawUnsafe(
    `SELECT b."instrumentId" AS iid, (b.date)::date AS dpart, COUNT(*) AS c
     FROM "Bar" b GROUP BY 1, 2 HAVING COUNT(*) > 1 LIMIT 8`
  );
  console.log("DUP_SAME_DAY:", JSON.stringify(dup));

  // 2. Các giá trị time-of-day khác nhau trong cột date
  const times = await db.$queryRawUnsafe(
    `SELECT DISTINCT (date)::time AS t, COUNT(*) AS c FROM "Bar" GROUP BY 1 ORDER BY 1 LIMIT 12`
  );
  console.log("TIME_OF_DAY:", JSON.stringify(times, (k, v) => (typeof v === "bigint" ? Number(v) : v)));

  // 3. Số bar 0/negative close hoặc volume âm (cấu trúc hỏng thật)
  const bad = await db.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM "Bar" WHERE close <= 0 OR open <= 0 OR high < low OR volume < 0`
  );
  console.log("BAD_BARS:", JSON.stringify(bad, (k, v) => (typeof v === "bigint" ? Number(v) : v)));

  // 4. Kiểm instrument 0-bar active + thiếu quote
  const instruments = await db.instrument.findMany({ where: { isActive: true }, select: { id: true, symbol: true, market: true, type: true } });
  const barMax = await db.bar.groupBy({ by: ["instrumentId"], _max: { date: true } });
  const hasBar = new Set(barMax.map((g) => g.instrumentId));
  const quotes = await db.quote.findMany({ select: { instrumentId: true } });
  const hasQ = new Set(quotes.map((q) => q.instrumentId));
  const zero = instruments.filter((i) => !hasBar.has(i.id)).map((i) => i.symbol);
  const noQ = instruments.filter((i) => !hasQ.has(i.id)).map((i) => `${i.symbol}(${i.market})`);
  console.log("ACTIVE:", instruments.length, "ZERO_BAR:", zero.length, JSON.stringify(zero.slice(0, 20)));
  console.log("NO_QUOTE:", noQ.length, JSON.stringify(noQ.slice(0, 8)));

  // 5. Mẫu ADTV so sánh: topByAdtv hiện tại (77 ngày ~55 phiên) vs đúng 45 phiên
  const { topByAdtv, ADTV_SESSIONS } = await import("../src/lib/dated-series");
  const current = await topByAdtv(10, { market: "HOSE", type: "STOCK" });
  console.log("TOP_ADTV_CURRENT:", current.map((t) => `${t.symbol}:${(t.adtv / 1e9).toFixed(2)}bd/${t.sessions}p`).join(" "));

  // Tính lại đúng đặc tả: mean của 45 bar CUỐI mỗi mã trong cùng cửa sổ
  const cutoff = new Date(Date.now() - Math.ceil(ADTV_SESSIONS * 1.7) * 86_400_000);
  const bars = await db.bar.findMany({
    where: { instrumentId: { in: instruments.filter((i) => i.market === "HOSE" && i.type === "STOCK").map((i) => i.id) }, date: { gte: cutoff } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, close: true, volume: true, value: true },
  });
  const byId = new Map<string, number[]>();
  for (const b of bars) {
    if (!(b.close > 0)) continue;
    const v = b.value != null ? Number(b.value) : b.close * b.volume;
    if (!(v > 0)) continue;
    const arr = byId.get(b.instrumentId) ?? [];
    arr.push(v);
    byId.set(b.instrumentId, arr);
  }
  const spec45 = [...byId.entries()]
    .map(([id, vals]) => {
      const tail = vals.slice(-45);
      return { id, adtv: tail.reduce((s, v) => s + v, 0) / tail.length, sessions: tail.length };
    })
    .filter((r) => r.sessions >= 10)
    .sort((a, b) => b.adtv - a.adtv)
    .slice(0, 12);
  const symById = new Map(instruments.map((i) => [i.id, i.symbol]));
  console.log("TOP_ADTV_SPEC45:", spec45.map((r) => `${symById.get(r.id)}:${(r.adtv / 1e9).toFixed(2)}bd`).join(" "));
  const currentIds = current.map((c) => c.id).sort();
  const specIds = spec45.slice(0, 10).map((r) => r.id).sort();
  console.log("BASKET_MATCH_TOP10:", JSON.stringify(currentIds) === JSON.stringify(specIds) ? "YES" : "NO");

  await db.$disconnect();
}

main().catch((e) => {
  console.error("SCRIPT_ERROR:", e);
  process.exit(1);
});
