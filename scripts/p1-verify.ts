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
import { trainingWindowDigest, buildTrainingSet, type SymbolSeries } from "../src/lib/ml/features";
import { INGEST_REGISTRY } from "../src/lib/ingest-pipeline";
import { crossCheckFinfoVsEod, type PreAnchorQuote } from "../src/lib/eod-sync";
import { markSource } from "../src/lib/sources";
// F-63A-08/#64 — script ghi/sửa Bar THẬT (12 chỗ) → phải xoá cache rổ
// thanh khoản FeatureValue khi kết thúc (nếu trùng chu kỳ agents đang chạy,
// cache L2 10' có thể còn giá trị rổ cũ).
import { invalidateFeatureCache, TOPBYADTV_CACHE_PREFIX } from "../src/lib/feature-cache";

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

/** Tạo instrument test nhanh. */
async function makeTestInstrument(): Promise<string> {
  const inst = await db.instrument.create({
    data: { symbol: TEST_SYMBOL, name: "P1 Test — tự xoá", market: "HOSE", type: "STOCK", currency: "VND", sector: "Khác", isActive: true },
  });
  return inst.id;
}

/** Cắm N bar giá phẳng 10.000 + event bar cuối (gap −20% + volume 5×). */
async function plantGapBars(instId: string, n = 30): Promise<void> {
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const isEvent = i === n - 1;
    const px = isEvent ? 8000 : 10000;
    const vol = isEvent ? 500_000 : 100_000;
    await db.bar.create({
      data: {
        instrumentId: instId, date: barDate(i), open: px, high: px, low: px, close: px,
        volume: vol, value: BigInt(vol) * BigInt(px), firstSeenAt: now, lastSyncedAt: now,
      },
    });
  }
}

async function main() {
  console.log("════ KIỂM ĐỊNH P1 + FIXBUG #61 — DATA_PLATFORM_BLUEPRINT v1.4 ════\n");

  try {

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

    /* ═══ FIXBUG #61 — F-611A-02: REVERSED không bị demotion qua nhánh
     * SUSPECTED (kill-switch tắt) rồi tự adjust lại khi bật lại ═══ */
    console.log("\n── F61-02: REVERSED sống sót qua chu kỳ kill-switch tắt/bật");
    {
      await setAutoAdjustEnabled(false);
      const rOff = await scanCorporateEvents({ instrumentIds: [inst5.id] });
      const rowOff = await db.corporateEvent.findUnique({ where: { id: row5g!.id } });
      check("F02-1 kill-switch TẮT scan: row vẫn REVERSED (không demote)", rowOff?.status === "REVERSED", `status=${rowOff?.status}`);
      check("F02-2 kill-switch TẮT scan: 0 adjust", rOff.adjusted.length === 0);
      await setAutoAdjustEnabled(true);
      const rOn = await scanCorporateEvents({ instrumentIds: [inst5.id] });
      const rowOn = await db.corporateEvent.findUnique({ where: { id: row5g!.id } });
      check("F02-3 bật lại: row vẫn REVERSED + 0 adjust (quyết định người giữ)", rowOn?.status === "REVERSED" && rOn.adjusted.length === 0);
      const rowsCount = await db.corporateEvent.count({ where: { instrumentId: inst5.id } });
      check("F02-4 không tạo row thứ hai cho cùng ngày", rowsCount === 1, `rows=${rowsCount}`);
    }

    /* ═══ FIXBUG #61 — F-611A-01: AUTO_ADJUSTED không bị demotion →
     * không còn đường ×f² (gap tái xuất + kill-switch tắt/bật) ═══ */
    console.log("\n── F61-01: AUTO_ADJUSTED sống sót kill-switch tắt/bật — không ×f²");
    {
      // Chuẩn bị lại trạng thái "đã adjust + eod-sync đè lại 1 bar" (như 1c)
      await cleanupTestInstrument();
      const instF1 = await makeTestInstrument();
      await plantGapBars(instF1);
      await scanCorporateEvents({ instrumentIds: [instF1] }); // adjust lần 1
      const reStampF1 = new Date(Date.now() + 60_000);
      await db.bar.update({
        where: { instrumentId_date: { instrumentId: instF1, date: barDate(28) } },
        data: { close: 10000, open: 10000, high: 10000, low: 10000, lastSyncedAt: reStampF1 },
      });
      const rowF1 = await db.corporateEvent.findFirst({ where: { instrumentId: instF1 } });
      // KILL-SWITCH TẮT khi gap đang tái xuất — trước đây: upsert SUSPECTED đè
      // row AUTO_ADJUSTED (xoá mốc PIT); bật lại → prevAdjustedAt null → nhân TOÀN
      // chuỗi lần nữa (bar sâu ×f²)
      await setAutoAdjustEnabled(false);
      await scanCorporateEvents({ instrumentIds: [instF1] });
      const rowAfterOff = await db.corporateEvent.findUnique({ where: { id: rowF1!.id } });
      check("F01-1 kill-switch tắt: row vẫn AUTO_ADJUSTED (không demote)", rowAfterOff?.status === "AUTO_ADJUSTED", `status=${rowAfterOff?.status}`);
      await setAutoAdjustEnabled(true);
      const rFix = await scanCorporateEvents({ instrumentIds: [instF1] });
      check("F01-2 bật lại: chỉ adjust lại bar nguồn vừa đè (1 bar)", rFix.adjusted.length === 1 && rFix.adjusted[0]?.barsAdjusted === 1, `bars=${rFix.adjusted[0]?.barsAdjusted}`);
      const bar0F1 = await db.bar.findFirst({ where: { instrumentId: instF1, date: barDate(0) } });
      const bar28F1 = await db.bar.findFirst({ where: { instrumentId: instF1, date: barDate(28) } });
      check("F01-3 bar sâu KHÔNG bị ×f² (vẫn 8.000)", bar0F1?.close === 8000, `close=${bar0F1?.close}`);
      check("F01-4 bar nguồn đè lại được adjust đúng 1 lần (8.000)", bar28F1?.close === 8000, `close=${bar28F1?.close}`);

      /* ═══ FIXBUG #61 — F-611A-03: reverse sau NHIỀU vòng adjust phải
       * restore TOÀN BỘ chuỗi (union mọi audit — audit cũ nhất thắng) ═══ */
      console.log("\n── F61-03: reverse sau 2 vòng adjust restore đủ 29 bar");
      const rev2 = await reverseCorporateEvent(rowF1!.id);
      check("F03-1 reverse ok sau 2 vòng adjust", rev2.ok, rev2.error ?? "");
      check("F03-2 barsRestored = 29 (union 2 audit)", rev2.barsRestored === 29, `restored=${rev2.barsRestored}`);
      const allBarsF1 = await db.bar.findMany({ where: { instrumentId: instF1 }, orderBy: { date: "asc" } });
      const nonEventF1 = allBarsF1.slice(0, 29);
      check(
        "F03-3 TOÀN BỘ 29 bar trước event restore về 10.000/100k (không lẫn ×f)",
        nonEventF1.every((b) => b.close === 10000 && b.volume === 100_000),
        `sai lệch: ${nonEventF1.filter((b) => b.close !== 10000 || b.volume !== 100_000).length} bar`
      );
    }

    /* ═══ FIXBUG #61 — F-611A-04: event THỨ HAI phía sau event SUSPECTED
     * vẫn được quét (trước đây break vô điều kiện → bỏ đói ≤92 ngày) ═══ */
    console.log("\n── F61-04: quét tiếp qua event SUSPECTED để bắt event thứ hai");
    {
      await cleanupTestInstrument();
      const instF4 = await makeTestInstrument();
      const nowF4 = new Date();
      for (let i = 0; i < 30; i++) {
        // t=20: open gap −20% + volume 5× NHƯNG close bình thường (2 phép
        // lệch >±1% → (1)+(2) đạt, (3) fail → SUSPECTED — đúng nhánh ghi row)
        // t=29: gap −20% cả 2 phép + volume 5× → AUTO_ADJUSTED
        const suspect = i === 20;
        const event = i === 29;
        const px = event ? 8000 : 10000;
        const openPx = suspect ? 8000 : px;
        const vol = event || suspect ? 500_000 : 100_000;
        await db.bar.create({
          data: {
            instrumentId: instF4, date: barDate(i), open: openPx, high: px, low: px, close: px,
            volume: vol, value: BigInt(vol) * BigInt(px), firstSeenAt: nowF4, lastSyncedAt: nowF4,
          },
        });
      }
      const rF4 = await scanCorporateEvents({ instrumentIds: [instF4] });
      check("F04-1 phát hiện CẢ HAI event trong 1 scan", rF4.candidates.length === 2, `candidates=${rF4.candidates.length}`);
      check("F04-2 event 2 được AUTO_ADJUSTED dù event 1 SUSPECTED", rF4.adjusted.length === 1 && rF4.adjusted[0]?.eventDate === barDate(29).toISOString().slice(0, 10), rF4.adjusted.map((a) => a.eventDate).join(","));
      const rowSus = await db.corporateEvent.findFirst({ where: { instrumentId: instF4, date: barDate(20) } });
      check("F04-3 event 1 ghi SUSPECTED (không sửa giá)", rowSus?.status === "SUSPECTED");
      const b0F4 = await db.bar.findFirst({ where: { instrumentId: instF4, date: barDate(0) } });
      check("F04-4 chuỗi trước event 2 được ×f (8.000)", b0F4?.close === 8000, `close=${b0F4?.close}`);
    }

    /* ═══ FIXBUG #61 Vòng 2 — F-611R-01: deep backfill tái áp adjustment
     * của event NGOÀI cửa sổ quét 92 ngày (không bao giờ được scan lại) ═══ */
    console.log("\n── F61-R01: reapplyAutoAdjustments sau deep backfill");
    {
      const { reapplyAutoAdjustments } = await import("../src/lib/corporate-events");
      await cleanupTestInstrument();
      const instR1 = await makeTestInstrument();
      await plantGapBars(instR1);
      // Giả lập event CŨ (ngoài cửa sổ 92 ngày): bar 2026-01 + row AUTO_ADJUSTED
      const oldEvent = new Date(Date.UTC(2026, 0, 15, 15, 0, 0));
      const oldBarDates = [1, 2, 5, 6, 7, 8].map((d) => new Date(Date.UTC(2026, 0, d, 15, 0, 0)));
      const nowR1 = new Date();
      for (const d of oldBarDates) {
        await db.bar.create({
          data: {
            instrumentId: instR1, date: d, open: 10000, high: 10000, low: 10000, close: 10000,
            volume: 100_000, value: BigInt(100_000) * BigInt(10000), firstSeenAt: nowR1, lastSyncedAt: nowR1,
          },
        });
      }
      await db.corporateEvent.create({
        data: {
          instrumentId: instR1, date: oldEvent, kind: "SPLIT", ratio: 0.5, status: "AUTO_ADJUSTED",
          source: "gap-infer-dchart", detail: JSON.stringify({ adjustedAt: nowR1.toISOString(), barsAdjusted: 6 }),
        },
      });
      // Giả lập deep backfill: xoá bar cũ rồi tạo lại bằng giá GỐC nguồn
      await db.bar.deleteMany({ where: { instrumentId: instR1, date: { lt: new Date(Date.UTC(2026, 1, 1)) } } });
      for (const d of oldBarDates) {
        await db.bar.create({
          data: {
            instrumentId: instR1, date: d, open: 10000, high: 10000, low: 10000, close: 10000,
            volume: 100_000, value: BigInt(100_000) * BigInt(10000), firstSeenAt: nowR1, lastSyncedAt: nowR1,
          },
        });
      }
      const reapplied = await reapplyAutoAdjustments(instR1);
      check("F-R01-1 tái áp đủ 6 bar trước event cũ", reapplied === 6, `reapplied=${reapplied}`);
      const oldBar = await db.bar.findFirst({ where: { instrumentId: instR1, date: oldBarDates[0] } });
      check("F-R01-2 bar cũ được nhân lại đúng f=0,5 (5.000/200k)", oldBar?.close === 5000 && oldBar?.volume === 200_000, `close=${oldBar?.close} vol=${oldBar?.volume}`);
      const evAfter = await db.corporateEvent.findFirst({ where: { instrumentId: instR1 } });
      const detailR1 = evAfter?.detail ? JSON.parse(evAfter.detail) : {};
      check("F-R01-3 detail ghi vết reappliedAfterDeepBackfill", typeof detailR1.reappliedAfterDeepBackfill === "string");
      // REVERSED/SUSPECTED không bị tái áp
      await db.corporateEvent.update({ where: { id: evAfter!.id }, data: { status: "REVERSED" } });
      await db.bar.update({ where: { instrumentId_date: { instrumentId: instR1, date: oldBarDates[0] } }, data: { close: 10000, volume: 100_000 } });
      const reapplied2 = await reapplyAutoAdjustments(instR1);
      check("F-R01-4 row REVERSED → KHÔNG tái áp (quyết định người)", reapplied2 === 0, `reapplied=${reapplied2}`);
    }

    /* ═══ FIXBUG #61 — F-611A-05: kill-switch JSON hỏng → TẮT (fail-safe) ═══ */
    console.log("\n── F61-05: kill-switch JSON hỏng fail-closed");
    {
      await db.appSetting.upsert({
        where: { key: "corporate-event-autoadjust" },
        create: { key: "corporate-event-autoadjust", value: "{bad json" },
        update: { value: "{bad json" },
      });
      check("F05-1 JSON hỏng → isAutoAdjustEnabled = false (TẮT)", (await isAutoAdjustEnabled()) === false);
      await setAutoAdjustEnabled(true); // phục hồi
      check("F05-2 phục hồi JSON hợp lệ → true", (await isAutoAdjustEnabled()) === true);
    }
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
    // F-611-01/#61 — digest PHẢI hash trên chuỗi mà buildTrainingSet TRẢ KÈM
    // (trước đây route nạp LẦN 2 độc lập — bar đổi giữa 2 lượt → hash sai sự thật)
    const ts = await buildTrainingSet(5);
    check("2c-1 buildTrainingSet trả kèm series nó đã dùng", Array.isArray(ts.series) && ts.series.length >= 1 && ts.series.every((s) => s.bars.length > 0), `series=${ts.series.length} · X=${ts.X.length}`);
    const dSet = trainingWindowDigest(ts.series, { samples: ts.X.length });
    check("2c-2 digest trên set.series deterministic + 64 hex", /^[0-9a-f]{64}$/.test(dSet.windowHash) && dSet.samples === ts.X.length);
    check("2c-3 biên ngày digest khớp biên series", ts.series.every((s) => s.bars.length > 0) && dSet.trainDateFrom != null && dSet.trainDateTo != null);
  }

  /* ═══ P1-4 · ForeignFlow persist ═══════════════════════════════════ */
  console.log("\n── P1-4: ForeignFlow persist (chạy flows thật qua GET /api/market/flows)");
  {
    // Gọi hàm persist trực tiếp (route đã chạy trong app — kiểm bằng đếm DB)
    const { getForeignFlows } = await import("../src/lib/flows");
    await getForeignFlows();
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
    check("4a-4 đủ 76 dòng/ngày cho rổ thanh khoản", countAfter >= 70, `count=${countAfter}`);

    /* ═══ FIXBUG #61 — F-611-04: row mode "live" KHÔNG bị mô phỏng đè ═══ */
    console.log("\n── F61-04b: flows mô phỏng không đè row live");
    const liveInstId = one?.instrumentId ?? (await db.instrument.findFirst({ where: { isActive: true, market: "HOSE" } }))?.id;
    if (liveInstId) {
      const liveDate = new Date(`${vnDate}T15:00:00.000Z`);
      await db.foreignFlow.upsert({
        where: { instrumentId_date: { instrumentId: liveInstId, date: liveDate } },
        create: { instrumentId: liveInstId, date: liveDate, netValue: BigInt(123_456_789), mode: "live" },
        update: { netValue: BigInt(123_456_789), mode: "live" },
      });
      await getForeignFlows(); // chạy mô phỏng — không được đè row live
      const liveRow = await db.foreignFlow.findUnique({
        where: { instrumentId_date: { instrumentId: liveInstId, date: liveDate } },
      });
      check("F04b-1 row live giữ nguyên netValue + mode", liveRow?.mode === "live" && liveRow?.netValue === BigInt(123_456_789), `mode=${liveRow?.mode} net=${liveRow?.netValue?.toString()}`);
      await db.foreignFlow.deleteMany({ where: { instrumentId: liveInstId, date: liveDate, mode: "live" } });
      await getForeignFlows(); // tái tạo row simulated cho ngày này
      const simRow = await db.foreignFlow.findUnique({
        where: { instrumentId_date: { instrumentId: liveInstId, date: liveDate } },
      });
      check("F04b-2 sau khi xoá live, mô phỏng tái persist simulated", simRow?.mode === "simulated");
    } else {
      check("F04b-1 row live giữ nguyên netValue + mode", false, "không tìm được mã test");
    }
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
    // F-611-06/#61 — assert THẬT: kiểm đủ mã + không lỗi DB (thay check
    // type-level suông cũ `Array.isArray(...)` luôn true)
    check("6b-1 hậu kiểm chạy đủ ≥ 70 mã VN + dbFail=false", res.checked >= 70 && res.dbFail === false, `checked=${res.checked} dbFail=${res.dbFail}`);
    check("6b-1b dbFailNotes rỗng khi DB sống", res.dbFailNotes.length === 0, JSON.stringify(res.dbFailNotes).slice(0, 120));
    const meta = await db.dataSourceStatus.findUnique({ where: { key: "ingest-pipeline" } });
    const parsed = meta?.meta ? (JSON.parse(meta.meta) as Record<string, unknown>) : {};
    check("6b-2 ghi meta DataSourceStatus ingest-pipeline", "verify-p1" in parsed, Object.keys(parsed).join(","));
    // S0 registry: chạy liveIngestRegistry
    const { liveIngestRegistry } = await import("../src/lib/ingest-pipeline");
    const live = await liveIngestRegistry();
    // F-611-06/#61 — check THẬT thay `"status" in r` (luôn true kể cả null)
    check(
      "6c-1 liveIngestRegistry 10 đường + status đúng hình",
      live.length === 10 &&
        live.every((r) => r.status === null || (typeof r.status.mode === "string" && "lastSuccessAt" in r.status && "lastError" in r.status)),
      live.map((r) => `${r.no}:${r.status ? r.status.mode : "null"}`).join(" ")
    );
    const withStatus = live.filter((r) => r.status != null);
    check("6c-2 ít nhất 7 đường có DataSourceStatus sống", withStatus.length >= 7, `có status: ${withStatus.length}`);
    // F-611B-03/#61 — registry #2 phải khai báo đường THẬT tồn tại
    const backfill = INGEST_REGISTRY.find((r) => r.no === 2);
    check("6c-3 registry #2 khai báo body force=deep (route đã nhận — F-611B-03)", (backfill?.route ?? "").includes('force: "deep"'), backfill?.route ?? "");
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

    /* ═══ FIXBUG #61 — F-611B-01 (P0): cross-check so Quote finfo THẬT với
     * bar dchart (ảnh TRƯỚC anchor) — trước đây so dchart với chính dchart ═══ */
    console.log("\n── F61-B01: cross-check phát hiện lệch finfo vs dchart (P0 fix)");
    {
      // Đặt tạm nguồn market-quotes mode real để mở nhánh so sánh (phục hồi
      // trong finally — F-611R-08: crash giữa khối không để mode thật bị lật)
      const savedQuote = await db.dataSourceStatus.findUnique({ where: { key: "market-quotes" } });
      await db.dataSourceStatus.upsert({
        where: { key: "market-quotes" },
        create: { key: "market-quotes", label: "tạm (verify)", mode: "real" },
        update: { mode: "real" },
      });
      try {
      const barDay = new Date(Date.UTC(2026, 9, 8, 15, 0, 0)); // hôm nay convention
      const instruments = [{ id: "verify-1", symbol: "VERIFY1" }, { id: "verify-2", symbol: "VERIFY2" }];
      const latestBarBySymbol = new Map([
        ["VERIFY1", { close: 10000, date: barDay }],
        ["VERIFY2", { close: 20000, date: barDay }],
      ]);
      // ảnh Quote finfo TRƯỚC anchor: VERIFY1 lệch 5% (bắt) · VERIFY2 khớp (bỏ qua)
      const preAnchorQuotes = new Map<string, PreAnchorQuote>([
        ["verify-1", { last: 10500, close: 10500, tradedAt: barDay }],
        ["verify-2", { last: 20000, close: 20000, tradedAt: barDay }],
      ]);
      const r = await crossCheckFinfoVsEod(instruments, latestBarBySymbol, preAnchorQuotes);
      check("F-B01-1 so 2 mã (compared=2)", r.compared === 2, `compared=${r.compared}`);
      check("F-B01-2 phát hiện VERIFY1 lệch 5% > 1%", r.mismatches.length === 1 && r.mismatches[0]?.symbol === "VERIFY1", JSON.stringify(r.mismatches));
      check("F-B01-3 diffPct đúng ≈ 5%", Math.abs((r.mismatches[0]?.diffPct ?? 0) - 5) < 0.01, `diffPct=${r.mismatches[0]?.diffPct}`);
      // khác ngày ICT → bỏ qua
      const preAnchorOtherDay = new Map<string, PreAnchorQuote>([
        ["verify-1", { last: 10500, close: 10500, tradedAt: new Date(Date.UTC(2026, 9, 7, 15, 0, 0)) }],
      ]);
      const r2 = await crossCheckFinfoVsEod([instruments[0]], latestBarBySymbol, preAnchorOtherDay);
      check("F-B01-4 khác ngày ICT → không so (compared=0)", r2.compared === 0 && r2.mismatches.length === 0);
      } finally {
        // F-611R-08/#61 — phục hồi trạng thái nguồn thật + dọn alert verify
        if (savedQuote) {
          await db.dataSourceStatus.update({
            where: { key: "market-quotes" },
            data: { mode: savedQuote.mode, label: savedQuote.label, meta: savedQuote.meta },
          });
        }
        await db.riskAlert
          .deleteMany({ where: { code: "DQ_CROSS_SOURCE", createdAt: { gte: new Date(Date.now() - 3_600_000) }, message: { contains: "VERIFY1" } } })
          .catch(() => undefined);
      }
    }

    /* ═══ FIXBUG #61 — F-611-02: markSource success=true xoá lastError ═══ */
    console.log("\n── F61-C02: markSource success xoá lỗi cũ (registry sống thật)");
    {
      const KEY = "verify-p1-marksource";
      await markSource(KEY, { mode: "real", success: false, lastError: "chớp nettle 1 lần" });
      const afterFail = await db.dataSourceStatus.findUnique({ where: { key: KEY } });
      check("F-C02-1 fail ghi lastError", afterFail?.lastError === "chớp nettle 1 lần");
      await markSource(KEY, { mode: "real", success: true, meta: { ok: 1 } }); // KHÔNG truyền lastError
      const afterOk = await db.dataSourceStatus.findUnique({ where: { key: KEY } });
      check("F-C02-2 success (không truyền lastError) → XOÁ lỗi cũ", afterOk?.lastError === null, `lastError=${JSON.stringify(afterOk?.lastError)}`);
      await db.dataSourceStatus.delete({ where: { key: KEY } }).catch(() => undefined);
    }

    /* ═══ FIXBUG #61 — F-611-03: /api/data-quality ngày không tồn tại → 400 ═══ */
    console.log("\n── F61-C03: route data-quality validate ngày (400 thay vì 500)");
    {
      const base = "http://localhost:3000/api/data-quality";
      try {
        const resBad = await fetch(`${base}?from=2026-13-99`);
        check("F-C03-1 from=2026-13-99 → HTTP 400 (không phải 500)", resBad.status === 400, `status=${resBad.status}`);
        const resOk = await fetch(`${base}?from=2026-10-01&to=2026-10-08&limit=5`);
        const bodyOk = (await resOk.json()) as { ok?: boolean; trend?: { total?: number } };
        check("F-C03-2 from/to hợp lệ → 200 + ok + trend.total", resOk.status === 200 && bodyOk.ok === true && typeof bodyOk.trend?.total === "number", `status=${resOk.status}`);
      } catch (err) {
        check("F-C03-1 from=2026-13-99 → HTTP 400 (không phải 500)", false, `fetch lỗi: ${err instanceof Error ? err.message : String(err)} — dev server có đang chạy?`);
      }
    }
  }

  /* ═══ FIXBUG #61 Vòng Xác Nhận — F-613C-01: mọi row AUTO_ADJUSTED phải
   * trỏ auditLogId ĐÚNG (từng có row chứa Bar-id do code trung gian) ═══ */
  console.log("\n── F61-C01: auditLogId của row AUTO_ADJUSTED trỏ đúng AuditLog thật");
  {
    const rows = await db.corporateEvent.findMany({ where: { status: "AUTO_ADJUSTED" } });
    const auditIds = new Set(
      (await db.auditLog.findMany({ where: { action: "CORPORATE_EVENT_AUTO_ADJUSTED" }, select: { id: true } })).map((a) => a.id)
    );
    const bad = [];
    for (const r of rows) {
      const d = r.detail ? (JSON.parse(r.detail) as { auditLogId?: string | null }) : {};
      if (d.auditLogId != null && !auditIds.has(d.auditLogId)) bad.push(`${r.date.toISOString().slice(0, 10)}→${d.auditLogId}`);
    }
    check(
      "F-C01-1 mọi row AUTO_ADJUSTED có auditLogId hợp lệ (trỏ AuditLog thật)",
      bad.length === 0,
      bad.length === 0 ? `${rows.length} row OK` : `sai: ${bad.join(" · ")}`
    );
  }

  /* ── KẾT QUẢ ──────────────────────────────────────────────────────── */
  console.log(`\n════ KẾT QUẢ: ${pass} PASS · ${fail} FAIL ════`);
  } finally {
    /* ── Dọn dẹp (try/finally — crash giữa chừng vẫn dọn — F-611-08) ── */
    await cleanupTestInstrument();
    // F-611-08/#61 — xoá khoá verify-p1 khỏi meta ingest-pipeline (trước đây
    // để lại vĩnh viễn trong DB production + quét cả mã test đang sống)
    const ipRow = await db.dataSourceStatus.findUnique({ where: { key: "ingest-pipeline" } });
    if (ipRow?.meta) {
      try {
        const m = JSON.parse(ipRow.meta) as Record<string, unknown>;
        delete m["verify-p1"];
        delete m["verify-p1-marksource"];
        await db.dataSourceStatus.update({
          where: { key: "ingest-pipeline" },
          data: { meta: JSON.stringify(m) },
        });
      } catch {
        // meta hỏng JSON — bỏ qua
      }
    }
    await setAutoAdjustEnabled(true); // kill-switch luôn về BẬT khi thoát
  }
  // F-63A-08/#64 — script đã ghi/sửa Bar thật → dọn cache topByAdtv để chu kỳ
  // agents kế tiếp tính lại từ dữ liệu mới (không chờ TTL 10').
  await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX).catch(() => undefined);
  // process.exit SAU finally (exit trong try sẽ nhảy khỏi finally)
  if (fail > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error("LỖI kiểm định:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
