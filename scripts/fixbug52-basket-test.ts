/** Kiểm định F6 — rổ top-10 ổn định qua market tick (ADTV EOD). */
import { db } from "@/lib/db";
import { loadTopSeries } from "@/lib/ml/features";

const a = await loadTopSeries(10, { sinceDays: 800 });
console.log("lần 1:", a.map((s) => s.symbol).join(", "));
console.log("số closes:", a.map((s) => s.closes.length).join("/"));
console.log("→ chờ market tick 6s...");
await new Promise((r) => setTimeout(r, 6_000));
const b = await loadTopSeries(10, { sinceDays: 800 });
console.log("lần 2:", b.map((s) => s.symbol).join(", "));
const same = a.map((s) => s.symbol).join() === b.map((s) => s.symbol).join();
console.log(same ? "PASS — rổ ổn định qua tick (F6: ADTV EOD)" : "FAIL — rổ vẫn xoay");
await db.$disconnect();
process.exit(same ? 0 : 1);
