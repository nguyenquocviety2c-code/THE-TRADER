/**
 * scripts/p1-verify.ts — KIỂM ĐỊNH GÓI P1 (phiên #60 — DATA_PLATFORM_BLUEPRINT
 * v1.3 §5): P1-1 CorporateEvent auto-adjust · P1-2 PIT · P1-3 cross-check ·
 * P1-4 ForeignFlow persist · P1-6 pipeline một cửa + S0 registry · P1-7
 * DataQualityReport.
 *
 * Nguyên tắc (Fixbug §5): mỗi kiểm thực đo DB THẬT, không tin code — synthetic
 * instrument riêng (P1TEST*) để không bẩn dữ liệu thật; dọn sạch sau mỗi phần.
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/p1-verify.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  scanOutlierBars,
  beyondBand,
  priceBand,
  runDataQualityChecks,
} from "../src/lib/data-quality";
import {
  scanCorporateEvents,
  reverseCorporateEvent,
  setAutoAdjustEnabled,
  isAutoAdjustEnabled,
} from "../src/lib/corporate-events";
import { parseYahooEvents, type RawYahooChartNode } from "../src/lib/intl-eod";
import { trainingWindowDigest, type SymbolSeries } from "../src/lib/ml/features";
import { INGEST_REGISTRY } from "../src/lib/ingest-pipeline";

const db = new PrismaClient();

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Tạo instrument test + dọn sau. */
const TEST_SYMBOL = "P1TEST";
async function cleanupTestInstrument() {
  const inst = await db.instrument.findUnique({ where: { symbol: TEST_SYMBOL } });
  if (inst) {
    await db.corporateEvent.deleteMany({ where: { instrumentId: inst.id } });
    await db.foreignFlow.deleteMany({ where: { instrumentId: inst.id } });
    await db.instrument.delete({ where: { id: inst.id } }); // cascade bar/quote
  }
}

/** Bar 15:00 UTC convention. */
function barDate(dayOffset: number): Date {
  const d = new Date(Date.UTC(2026, 8, 1, 15, 0, 0)); // 2026-09-01
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d;
}

async function main() {
  console.log("════ KIỂM ĐỊNH P1 — DATA_PLATFORM_BLUEPRINT v1.3 (phiên #60) ════\n");

  /* ── Phần 0: dọn môi trường ───────────────────────────────────────── */
  await cleanupTestInstrument();
  // Kill-switch về mặc định BẬT
  await setAutoAdjustEnabled(true);

  /* ═══ P1-1 · CorporateEvent + TỰ ĐIỀU CHỈNH ═════════════════════════ */

  console.log("── P1-1a: cắm gap −20% (cổ thưởng 1,25) + volume 5× → AUTO_ADJUSTED");
  {
    // 30 bar giá 10.000₫, ADTV value = 10000×100k = 1e9; event bar: open/close
    // 8.000 (−20% vượt dải HOSE 7%), volume 500k (5×) → value 8.000×500k=4e9 ≥ 3×ADTV
    const inst = await db.instrument.create({
      data: {
        symbol: TEST_SYMBOL,
        name: "P1 Test — tự xoá",
        market: "HOSE",
        type: "STOCK",
        currency: "VND",
        sector: "Khác",
        isActive: true,
      },
    });
    const now = new Date();
    for (let i = 0; i < 30; i++) {
      const isEvent = i === 29;
      const px = isEvent ? 8000 : 10000;
      const vol = isEvent ? 500_000 : 100_000;
      await db.bar.create({
        data: {
          instrumentId: inst.id,
          date: barDate(i),
          open: px,
          high: px,
          low: px,
          close: px,
          volume: vol,
          value: BigInt(vol) * BigInt(px),
          firstSeenAt: now,
          lastSyncedAt: now,
        },
      });
    }

    const result = await scanCorporateEvents({ instrumentIds: [inst.id] });
    check("1a-1 scan phát hiện 1 candidate", result.candidates.length === 1, JSON.stringify(result.candidates.map((c) => ({ f: c.f, agree: c.agreementPct }))));
    check("1a-2 candidate mức CAO (highConfidence)", result.candidates[0]?.highConfidence === true);
    check("1a-3 f = 0,8 (open 8.000 / close 10.000)", Math.abs((result.candidates[0]?.f ?? 0) - 0.8) < 0.001);
    check("1a-4 đã AUTO_ADJUSTED 1 event", result.adjusted.length === 1);
    check("1a-5 verdict A9 chạy lại sau adjust (nghiệm thu P1-1)", result.verdictAfter != null, `level=${result.verdictAfter?.level}`);

    // Bar trước event: giá ×0,8 (8.000→ wait: 10000×0.8 = 8000), volume ×1,25
    const before = await db.bar.findFirst({
      where: { instrumentId: inst.id, date: barDate(0) },
    });
    check("1a-6 giá bar ĐẦU ×f = 8.000₫", before?.close === 8000, `close=${before?.close}`);
    check("1a-7 volume ×(1/f) = 125.000", before?.volume === 125_000, `vol=${before?.volume}`);
    check("1a-8 value tính lại = 125.000×8.000 = 1e9", before?.value === BigInt("1000000000"), `value=${before?.value?.toString()}`);

    // Event bar giữ nguyên
    const eventBar = await db.bar.findFirst({
      where: { instrumentId: inst.id, date: barDate(29) },
    });
    check("1a-9 bar event GIỮ NGUYÊN (8.000 / 500k)", eventBar?.close === 8000 && eventBar?.volume === 500_000);

    // CorporateEvent row đúng
    const row = await db.corporateEvent.findFirst({
      where: { instrumentId: inst.id },
    });
    check("1a-10 row AUTO_ADJUSTED · kind BONUS · ratio 0,8", row?.status === "AUTO_ADJUSTED" && row?.kind === "BONUS" && Math.abs((row?.ratio ?? 0) - 0.8) < 0.001);

    // AuditLog có pre-values đủ đảo ngược
    const audit = await db.auditLog.findFirst({
      where: { action: "CORPORATE_EVENT_AUTO_ADJUSTED", entityId: inst.id },
      orderBy: { createdAt: "desc" },
    });
    check("1a-11 AuditLog tồn tại", audit != null);
    const pre = audit?.before ? (JSON.parse(audit.before) as { bars?: unknown[] }) : null;
    check("1a-12 AuditLog pre-values đủ 29 bar", (pre?.bars?.length ?? 0) === 29, `bars=${pre?.bars?.length}`);

    // Gap sau adjust PHẢI SẠCH (outlier per-symbol — nghiêm thu P1-1)
    const barsAfter = await db.bar.findMany({
      where: { instrumentId: inst.id },
      orderBy: { date: "asc" },
    });
    const scanAfter = scanOutlierBars("HOSE", "STOCK", barsAfter);
    check("1a-13 outlier sạch ở vùng vừa điều chỉnh", scanAfter.bandViolations === 0 && !scanAfter.splitSuspect, `band=${scanAfter.bandViolations} split=${scanAfter.splitSuspect}`);

    /* ── P1-1b: idempotent — scan lần 2 KHÔNG adjust thêm ── */
    const result2 = await scanCorporateEvents({ instrumentIds: [inst.id] });
    check("1b-1 scan lần 2: 0 candidate (gap đã sạch)", result2.candidates.length === 0 && result2.adjusted.length === 0);
    const before2 = await db.bar.findFirst({
      where: { instrumentId: inst.id, date: barDate(0) },
    });
    check("1b-2 giá không bị nhân lần 2 (vẫn 8.000)", before2?.close === 8000);

    /* ── P1-1c: eod-sync đè lại lookback → scan tái adjust ĐÚNG phần gửi lại
     * (chống double-apply bằng lastSyncedAt — mấu chốt hội tụ P1-1) ── */
    const reStamp = new Date(Date.now() + 60_000); // lastSyncedAt MỚI hơn adjustedAt
    await db.bar.update({
      where: { instrumentId_date: { instrumentId: inst.id, date: barDate(28) } },
      data: { close: 10000, open: 10000, high: 10000, low: 10000, lastSyncedAt: reStamp },
    });
    const result3 = await scanCorporateEvents({ instrumentIds: [inst.id] });
    // bar 28 gốc (10.000) → gap 8.000/10.000 vượt dải → adjust lại CHỈ bar 28
    check("1c-1 scan lần 3 phát hiện gap tái xuất", result3.candidates.length === 1);
    const bar28 = await db.bar.findFirst({
      where: { instrumentId: inst.id, date: barDate(28) },
    });
    const bar0 = await db.bar.findFirst({
      where: { instrumentId: inst.id, date: barDate(0) },
    });
    check("1c-2 bar được gửi lại gốc (28) → ×f = 8.000", bar28?.close === 8000, `close=${bar28?.close}`);
    check("1c-3 bar sâu KHÔNG bị nhân đôi (0 vẫn 8.000)", bar0?.close === 8000, `close=${bar0?.close}`);

    /* ── P1-1d: gap −50% (1:5) cũng bắt được ── */
    await cleanupTestInstrument();
    const inst2 = await db.instrument.create({
      data: { symbol: TEST_SYMBOL, name: "P1 Test — tự xoá", market: "HOSE", type: "STOCK", currency: "VND", sector: "Khác", isActive: true },
    });
    const now2 = new Date();
    for (let i = 0; i < 30; i++) {
      const isEvent = i === 29;
      const px = isEvent ? 5000 : 10000;
      const vol = isEvent ? 600_000 : 100_000;
      await db.bar.create({
        data: {
          instrumentId: inst2.id, date: barDate(i), open: px, high: px, low: px, close: px,
          volume: vol, value: BigInt(vol) * BigInt(px), firstSeenAt: now2, lastSyncedAt: now2,
        },
      });
    }
    const result4 = await scanCorporateEvents({ instrumentIds: [inst2.id] });
    check("1d-1 gap −50% (1:5) → AUTO_ADJUSTED f=0,5", result4.adjusted.length === 1 && Math.abs((result4.adjusted[0]?.f ?? 0) - 0.5) < 0.001);
    const b0 = await db.bar.findFirst({ where: { instrumentId: inst2.id, date: barDate(0) } });
    check("1d-2 giá ×0,5 = 5.000", b0?.close === 5000, `close=${b0?.close}`);

    /* ── P1-1e: kill-switch TẮT → SUSPECTED, không sửa giá ── */
    await cleanupTestInstrument();
    const inst3 = await db.instrument.create({
      data: { symbol: TEST_SYMBOL, name: "P1 Test — tự xoá", market: "HOSE", type: "STOCK", currency: "VND", sector: "Khác", isActive: true },
    });
    const now3 = new Date();
    for (let i = 0; i < 30; i++) {
      const isEvent = i === 29;
      const px = isEvent ? 8000 : 10000;
      const vol = isEvent ? 500_000 : 100_000;
      await db.bar.create({
        data: {
          instrumentId: inst3.id, date: barDate(i), open: px, high: px, low: px, close: px,
          volume: vol, value: BigInt(vol) * BigInt(px), firstSeenAt: now3, lastSyncedAt: now3,
        },
      });
    }
    await setAutoAdjustEnabled(false);
    check("1e-1 kill-switch đọc lại = false", (await isAutoAdjustEnabled()) === false);
    const result5 = await scanCorporateEvents({ instrumentIds: [inst3.id] });
    check("1e-2 kill-switch tắt → 0 adjust", result5.adjusted.length === 0);
    const row5 = await db.corporateEvent.findFirst({ where: { instrumentId: inst3.id } });
    check("1e-3 row SUSPECTED (ghi nhận trung thực)", row5?.status === "SUSPECTED");
    const b0e = await db.bar.findFirst({ where: { instrumentId: inst3.id, date: barDate(0) } });
    check("1e-4 giá KHÔNG bị sửa (10.000)", b0e?.close === 10000);
    await setAutoAdjustEnabled(true);

    /* ── P1-1f: volume < 3× ADTV → KHÔNG tạo row (bad tick để A9 lo) ── */
    await cleanupTestInstrument();
    const inst4 = await db.instrument.create({
      data: { symbol: TEST_SYMBOL, name: "P1 Test — tự xoá", market: "HOSE", type: "STOCK", currency: "VND", sector: "Khác", isActive: true },
    });
    const now4 = new Date();
    for (let i = 0; i < 30; i++) {
      const isEvent = i === 29;
      const px = isEvent ? 8000 : 10000;
      const vol = isEvent ? 120_000 : 100_000; // value event 9.6e8 < 3×ADTV 1e9
      await db.bar.create({
        data: {
          instrumentId: inst4.id, date: barDate(i), open: px, high: px, low: px, close: px,
          volume: vol, value: BigInt(vol) * BigInt(px), firstSeenAt: now4, lastSyncedAt: now4,
        },
      });
    }
    const result6 = await scanCorporateEvents({ instrumentIds: [inst4.id] });
    check("1f-1 volume < 3× ADTV → 0 candidate + 0 row", result6.candidates.length === 0);
    const rows4 = await db.corporateEvent.count({ where: { instrumentId: inst4.id } });
    check("1f-2 bảng CorporateEvent KHÔNG nhận row rác", rows4 === 0);

    /* ── P1-1g: đảo ngược bằng AuditLog pre-values ── */
    await cleanupTestInstrument();
    const inst5 = await db.instrument.create({
      data: { symbol: TEST_SYMBOL, name: "P1 Test — tự xoá", market: "HOSE", type: "STOCK", currency: "VND", sector: "Khác", isActive: true },
    });
    const now5 = new Date();
    for (let i = 0; i < 30; i++) {
      const isEvent = i === 29;
      const px = isEvent ? 8000 : 10000;
      const vol = isEvent ? 500_000 : 100_000;
      await db.bar.create({
        data: {
          instrumentId: inst5.id, date: barDate(i), open: px, high: px, low: px, close: px,
          volume: vol, value: BigInt(vol) * BigInt(px), firstSeenAt: now5, lastSyncedAt: now5,
        },
      });
    }
    await scanCorporateEvents({ instrumentIds: [inst5.id] });
    const row5g = await db.corporateEvent.findFirst({ where: { instrumentId: inst5.id } });
    const rev = await reverseCorporateEvent(row5g!.id);
    check("1g-1 reverse ok", rev.ok, rev.error ?? "");
    const b0g = await db.bar.findFirst({ where: { instrumentId: inst5.id, date: barDate(0) } });
    check("1g-2 bar restore về 10.000 / 100.000", b0g?.close === 10000 && b0g?.volume === 100_000);
    const rowAfterRev = await db.corporateEvent.findUnique({ where: { id: row5g!.id } });
    check("1g-3 status → REVERSED", rowAfterRev?.status === "REVERSED");
    // Scan lại sau reverse: gap tái xuất nhưng status REVERSED → KHÔNG tự adjust lại
    const result7 = await scanCorporateEvents({ instrumentIds: [inst5.id] });
    check("1g-4 scan sau REVERSED KHÔNG tự adjust lại (kill-switch per-event)", result7.adjusted.length === 0);
  }

  /* ═══ P1-1h: Yahoo events parse (US/HK — nguồn chính xác) ══════════ */
  console.log("\n── P1-1h: parse payload events Yahoo (US/HK)");
  {
    const node: RawYahooChartNode = {
      timestamp: [1700000000],
      indicators: { quote: [{ open: [1], high: [1], low: [1], close: [1], volume: [1] }] },
      events: {
        splits: [{ date: 1700095400, numerator: 4, denominator: 1 }],
        dividends: [{ date: 1700181800, amount: 0.25 }],
      },
    };
    const evs = parseYahooEvents(node);
    check("1h-1 parse được 2 events (1 split + 1 dividend)", evs.length === 2);
    const split = evs.find((e) => e.kind === "SPLIT");
    const div = evs.find((e) => e.kind === "DIVIDEND");
    check("1h-2 split 4:1 → f giá = denominator/numerator = 0,25", Math.abs((split?.ratio ?? 0) - 0.25) < 1e-9);
    check("1h-3 dividend ratio = 0 (không đổi hệ số giá)", (div?.ratio ?? -1) === 0);
    check("1h-4 event date đổi về convention 15:00 UTC", split?.date.getUTCHours() === 15);
    const evs2 = parseYahooEvents({ timestamp: [] });
    check("1h-5 payload rỗng → 0 events (không crash)", evs2.length === 0);
  }

  /* ═══ P1-2 · PIT ═══════════════════════════════════════════════════ */
  console.log("\n── P1-2: PIT Bar + MlModel window-hash");
  {
    // Bar thật: firstSeenAt ≤ lastSyncedAt, đều có giá trị
    const b = await db.bar.findFirst({ orderBy: { date: "desc" } });
    check("2a-1 bar mới nhất có PIT timestamps", b?.firstSeenAt != null && b?.lastSyncedAt != null);

    // trainingWindowDigest: deterministic + nhạy thay đổi
    const series: SymbolSeries[] = [
      {
        symbol: "AAA",
        instrumentId: "x",
        bars: [
          { date: new Date("2026-09-01T15:00:00Z"), close: 10000, volume: 1000 },
          { date: new Date("2026-09-02T15:00:00Z"), close: 10100, volume: 1100 },
        ],
        closes: [10000, 10100],
        volumes: [1000, 1100],
      },
    ];
    const d1 = trainingWindowDigest(series);
    const d2 = trainingWindowDigest(series);
    check("2b-1 digest deterministic (2 lần cùng hash)", d1.windowHash === d2.windowHash && /^[0-9a-f]{64}$/.test(d1.windowHash));
    series[0].bars[1].close = 10200; // restate 1 bar
    const d3 = trainingWindowDigest(series);
    check("2b-2 bar bị đè → hash KHÁC (phát hiện PIT leak)", d3.windowHash !== d1.windowHash);
    check("2b-3 biên ngày train from/to đúng", d1.trainDateFrom === "2026-09-01" && d1.trainDateTo === "2026-09-02");
    check("2b-4 meta đủ trường (samples/symbols/horizon/digestVersion)", d1.samples === 0 && d1.symbols.length === 1 && d1.horizonDays === 5 && d1.digestVersion.includes("sha256"));
  }

  /* ═══ P1-4 · ForeignFlow persist ═══════════════════════════════════ */
  console.log("\n── P1-4: ForeignFlow persist (chạy flows thật qua GET /api/market/flows)");
  {
    // Gọi hàm persist trực tiếp (route đã chạy trong app — kiểm bằng đếm DB)
    const { getForeignFlows } = await import("../src/lib/flows");
    await getForeignFlows();
    const today = new Date();
    const vnDate = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    const rows = await db.foreignFlow.findMany({
      where: { date: { gte: new Date(`${vnDate}T00:00:00Z`), lte: new Date(`${vnDate}T23:59:59Z`) } },
      take: 5,
    });
    check("4a-1 ForeignFlow có dòng hôm nay (mode simulated)", rows.length > 0 && rows.every((r) => r.mode === "simulated"), `rows=${rows.length}`);
    const one = rows[0];
    check("4a-2 netValue BigInt VND hợp lệ (|net| ≤ 80 tỷ)", one != null && Math.abs(Number(one.netValue)) <= 8.1e10);
    // Idempotent: chạy lại không nhân đôi
    const countBefore = await db.foreignFlow.count({ where: { date: { gte: new Date(`${vnDate}T00:00:00Z`) } } });
    await getForeignFlows();
    const countAfter = await db.foreignFlow.count({ where: { date: { gte: new Date(`${vnDate}T00:00:00Z`) } } });
    check("4a-3 chạy lại KHÔNG nhân đôi (upsert idempotent)", countBefore === countAfter, `${countBefore} → ${countAfter}`);
    void today;
  }

  /* ═══ P1-6 · Pipeline một cửa + registry ═══════════════════════════ */
  console.log("\n── P1-6: registry 10 đường + chuỗi hậu kiểm");
  {
    check("6a-1 INGEST_REGISTRY đủ 10 đường §0.3", INGEST_REGISTRY.length === 10, INGEST_REGISTRY.map((r) => r.no).join(","));
    const eod = INGEST_REGISTRY.find((r) => r.no === 1);
    check("6a-2 đường #1 khai báo hậu kiểm đầy đủ", (eod?.postCheck ?? "").includes("P1-1") && (eod?.postCheck ?? "").includes("P1-3"));
    // runPostIngestChecks chạy được độc lập (route đã tích hợp — verify src)
    const { runPostIngestChecks } = await import("../src/lib/ingest-pipeline");
    const res = await runPostIngestChecks({ route: "verify-p1", includeCorporateScan: false });
    check("6b-1 runPostIngestChecks chạy → có outlierSymbols/splitSuspects", Array.isArray(res.outlierSymbols) && Array.isArray(res.splitSuspects));
    const meta = await db.dataSourceStatus.findUnique({ where: { key: "ingest-pipeline" } });
    const parsed = meta?.meta ? (JSON.parse(meta.meta) as Record<string, unknown>) : {};
    check("6b-2 ghi meta DataSourceStatus ingest-pipeline", "verify-p1" in parsed, Object.keys(parsed).join(","));
    // S0 registry: chạy liveIngestRegistry
    const { liveIngestRegistry } = await import("../src/lib/ingest-pipeline");
    const live = await liveIngestRegistry();
    check("6c-1 liveIngestRegistry 10 đường + status sống", live.length === 10 && live.every((r) => "status" in r));
    const withStatus = live.filter((r) => r.status != null);
    check("6c-2 ít nhất 7 đường có DataSourceStatus sống", withStatus.length >= 7, `có status: ${withStatus.length}`);
  }

  /* ═══ P1-7 · DataQualityReport ═════════════════════════════════════ */
  console.log("\n── P1-7: DataQualityReport (ghi từ A9 + truy vấn asOf)");
  {
    const verdict = await runDataQualityChecks();
    const row = await db.dataQualityReport.create({
      data: {
        asOf: new Date(verdict.asOf),
        level: verdict.level,
        checks: JSON.stringify(verdict.checks),
        summary: JSON.stringify(verdict.summary),
      },
    });
    check("7a-1 ghi report {asOf, level, checks, summary}", row.level === verdict.level);
    const t0 = Date.now();
    const found = await db.dataQualityReport.findMany({
      where: { asOf: { gte: new Date(Date.now() - 86_400_000), lte: new Date() } },
      orderBy: { asOf: "desc" },
      take: 30,
    });
    const ms = Date.now() - t0;
    check("7a-2 truy vấn asOf < 100ms (test 8 blueprint)", ms < 100 && found.length >= 1, `${ms}ms · ${found.length} rows`);
    const parsed = JSON.parse(found[0].checks) as unknown[];
    check("7a-3 checks parse lại đủ cấu trúc", Array.isArray(parsed) && parsed.length >= 6);
    // Dọn 2 report verify để không đếm nhầm E2E
    await db.dataQualityReport.delete({ where: { id: row.id } });
  }

  /* ═══ P1-3 · Cross-check (hàm trong eod-sync — verify logic thuần) ══ */
  console.log("\n── P1-3: cross-check finfo vs dchart (logic + ngưỡng)");
  {
    // beyondBand dùng chung: gap 1,5% không vượt; gap 20% vượt
    check("3a-1 lệch 1,5% trong dải (không cảnh báo)", !beyondBand(10150, 10000, 0.07));
    check("3a-2 gap −20% vượt dải HOSE (điều kiện P1-1)", beyondBand(8000, 10000, 0.07));
    check("3a-3 priceBand INDEX = null (không gap-infer)", priceBand("HOSE", "INDEX") == null);
    check("3a-4 priceBand US/HK = null (crash thật không bị bắt)", priceBand("US", "STOCK") == null);
  }

  /* ── Dọn dẹp ──────────────────────────────────────────────────────── */
  await cleanupTestInstrument();
  console.log(`\n════ KẾT QUẢ: ${pass} PASS · ${fail} FAIL ════`);
  if (fail > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error("LỖI kiểm định:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
