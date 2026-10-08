/**
 * Kiểm định Fixbug #59 — Vòng 1 fixes (F-591-01/02/03).
 * Chạy: env -u DATABASE_URL bun scripts/fixbug59-verify.ts
 *
 * F-591-01: topByAdtv đúng hợp đồng 45 PHIÊN — mean 45 bar cuối, không phải
 *           toàn cửa sổ 77 ngày (~53 phiên); rổ ổn định 2 lần gọi.
 * F-591-02: DB không đọc được → verdict SEVERE (không còn PASS-mù).
 * F-591-03: readiness A9 take 70 == S2 take 70 (cùng số).
 * Hồi quy: verdict 6 phép với DB thật không đổi cấu trúc; ready 10/10.
 */
import { topByAdtv, ADTV_SESSIONS } from "../src/lib/dated-series";
import { db } from "../src/lib/db";

let failures = 0;
function check(name: string, ok: boolean, evidence: string) {
  console.log(`${ok ? "PASS" : "FAIL"} · ${name} — ${evidence}`);
  if (!ok) failures++;
}

async function main() {
  /* ── F-591-01 · đúng hợp đồng 45 phiên ───────────────────────────── */
  const basket = await topByAdtv(10, { market: "HOSE", type: "STOCK" });
  check(
    "F-591-01a · mọi mã trong rổ có sessions ≤ 45 (không còn 53)",
    basket.every((t) => t.sessions <= ADTV_SESSIONS),
    `sessions=${basket.map((t) => t.sessions).join(",")}`
  );
  // Đối chiếu tay: mean 45 bar cuối của từng mã top-10
  const ids = basket.map((t) => t.id);
  const cutoff = new Date(Date.now() - 77 * 86_400_000);
  const bars = await db.bar.findMany({
    where: { instrumentId: { in: ids }, date: { gte: cutoff } },
    orderBy: [{ instrumentId: "asc" }, { date: "asc" }],
    select: { instrumentId: true, close: true, volume: true, value: true },
  });
  const valsById = new Map<string, number[]>();
  for (const b of bars) {
    if (!(b.close > 0)) continue;
    const v = b.value != null ? Number(b.value) : b.close * b.volume;
    if (!(v > 0)) continue;
    const arr = valsById.get(b.instrumentId) ?? [];
    arr.push(v);
    valsById.set(b.instrumentId, arr);
  }
  let maxDiff = 0;
  for (const t of basket) {
    const tail = (valsById.get(t.id) ?? []).slice(-ADTV_SESSIONS);
    const manual = tail.reduce((s, v) => s + v, 0) / tail.length;
    maxDiff = Math.max(maxDiff, Math.abs(manual - t.adtv) / Math.max(1, t.adtv));
  }
  check(
    "F-591-01b · ADTV khớp mean-45-bar-cuối tính tay (sai số tương đối < 1e-12)",
    maxDiff < 1e-12,
    `maxRelDiff=${maxDiff.toExponential(2)}`
  );
  // Ổn định: gọi lần 2 → rổ GIỐNG HỆT (F6 regression)
  const basket2 = await topByAdtv(10, { market: "HOSE", type: "STOCK" });
  check(
    "F-591-01c · rổ ổn định 2 lần gọi (F6 regression)",
    JSON.stringify(basket.map((t) => t.symbol)) === JSON.stringify(basket2.map((t) => t.symbol)),
    basket.map((t) => t.symbol).join(" · ")
  );
  console.log(`INFO · rổ top-10 sau vá: ${basket.map((t) => `${t.symbol}(${(t.adtv / 1e9).toFixed(1)}bd/${t.sessions}p)`).join(" ")}`);

  /* ── F-591-02 · DB chết → verdict SEVERE ──────────────────────────── */
  // Tái hiện: đắp một client Prisma hỏng (URL không kết nối được) đè lên db
  // rồi gọi runDataQualityChecks — TRƯỚC vá kịch bản này cho PASS.
  const { PrismaClient } = await import("@prisma/client");
  const savedDb = (globalThis as Record<string, unknown>).__PRISMA_TEST_OVERRIDE__;
  void savedDb;
  // Thay thế phương thức query bằng reject mô phỏng lỗi mạng/DB
  const origFindMany = db.instrument.findMany.bind(db.instrument);
  const origQuoteFindMany = db.quote.findMany.bind(db.quote);
  const origGroupBy = db.bar.groupBy.bind(db.bar);
  const rejecter = () => Promise.reject(new Error("P1001: Can't reach database server (mô phỏng)"));
  (db.instrument as unknown as { findMany: typeof rejecter }).findMany = rejecter;
  (db.quote as unknown as { findMany: typeof rejecter }).findMany = rejecter;
  (db.bar as unknown as { groupBy: typeof rejecter }).groupBy = rejecter;
  const { runDataQualityChecks } = await import("../src/lib/data-quality");
  const brokenVerdict = await runDataQualityChecks();
  (db.instrument as unknown as { findMany: typeof origFindMany }).findMany = origFindMany;
  (db.quote as unknown as { findMany: typeof origQuoteFindMany }).findMany = origQuoteFindMany;
  (db.bar as unknown as { groupBy: typeof origGroupBy }).groupBy = origGroupBy;
  const firstCheck = brokenVerdict.checks[0];
  check(
    "F-591-02a · DB chết → verdict SEVERE (không còn PASS-mù)",
    brokenVerdict.level === "SEVERE",
    `level=${brokenVerdict.level}`
  );
  check(
    "F-591-02b · phép kiểm nguồn mô tả rõ query lỗi",
    firstCheck?.kind === "source" && firstCheck.detail.includes("KHÔNG đọc được DB") && firstCheck.detail.includes("instrument"),
    (firstCheck?.detail ?? "").slice(0, 120)
  );

  /* ── F-591-03 + hồi quy verdict với DB thật ──────────────────────── */
  const verdict = await runDataQualityChecks();
  check(
    "F-591-03/hồi quy · 6 phép kiểm đủ kind (freshness·gap·outlier·split·source·readiness)",
    ["freshness", "gap", "outlier", "split", "source", "readiness"].every((k) =>
      verdict.checks.some((c) => c.kind === k)
    ) && verdict.checks.every((c) => c.level !== "SEVERE" || c.detail.includes("DB") || c.kind !== "source"),
    `kinds=${verdict.checks.map((c) => c.kind).join(",")}`
  );
  check(
    "F-591-03 · readiness vẫn 10/10 (take 70 không làm hỏng)",
    verdict.summary.readinessTotal === 10 && verdict.summary.readinessReady === 10,
    `${verdict.summary.readinessReady}/${verdict.summary.readinessTotal} — thiếu: ${verdict.summary.readinessMissing.join(",") || "không"}`
  );
  check(
    "hồi quy · verdict DB thật vẫn phơi vấn đề thật (SEVERE outlier như baseline)",
    verdict.checks.find((c) => c.kind === "outlier")?.level === "SEVERE",
    `outlier=${verdict.checks.find((c) => c.kind === "outlier")?.level}`
  );
  void PrismaClient;
  await db.$disconnect();
  console.log(failures === 0 ? "ALL_CHECKS_PASS" : `HAS_${failures}_FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SCRIPT_ERROR:", e);
  process.exit(1);
});
