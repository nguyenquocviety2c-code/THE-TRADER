/**
 * scripts/p2-verify.ts — KIỂM ĐỊNH GÓI P2 (phiên #62 — DATA_PLATFORM_BLUEPRINT
 * v1.6 §5): P2-1 notify pending-egress · P2-2 news reliability · P2-3
 * FeatureValue cache (điều kiện #61 dương tính 750-850ms > 200ms) · P2-4
 * lịch giao dịch chính thức VN + overlay runtime.
 *
 * Nguyên tắc (Fixbug §5): mỗi kiểm thực đo DB THẬT, không tin code; dọn sạch
 * mọi cấu hình/row test sau mỗi phần (notify settings · overlay vn-holidays ·
 * outbox rows · FeatureValue rows).
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/p2-verify.ts
 */
import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";
import { topByAdtv } from "../src/lib/dated-series";
import {
  cacheGetJson,
  invalidateFeatureCache,
  clearFeatureCacheL1,
  featureCacheStats,
  TOPBYADTV_CACHE_PREFIX,
} from "../src/lib/feature-cache";
import {
  getNotifySettings,
  saveNotifySettings,
  dispatchDigest,
  retryPendingOutbox,
  listOutbox,
} from "../src/lib/notify";
import {
  getVnHolidayOverlay,
  saveVnHolidayOverlay,
  isOfficialTradingDay,
  officialCalendarView,
  upcomingHolidays,
} from "../src/lib/vn-calendar";
import { ingestNews } from "../src/lib/news";
import { runDataQualityChecks } from "../src/lib/data-quality";

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

function ictNow(): { date: string } {
  return { date: new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10) };
}

/* ═══════════════ A · P2-3 — FeatureValue cache ═══════════════ */

async function verifyFeatureCache() {
  console.log("\n── A · P2-3 FeatureValue cache (L1 + bảng Postgres) ──");
  const KEY = "topByAdtv:HOSE:STOCK:10";

  // A0 — xoá sạch trạng thái cache trước khi đo
  await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX);
  const preRows = await db.featureValue.count({ where: { key: { startsWith: TOPBYADTV_CACHE_PREFIX } } });
  check("A0 invalidate ban đầu xoá sạch row FeatureValue", preRows === 0, `count=${preRows}`);

  // A1 — ba trạng thái đo trung thực (RTT Supabase ~95-105ms/query là chi phí
  // cứng của WAN; trước cache #61: mỗi lần gọi 2 query × 7-8 call-site/chu kỳ
  // ≈ 750-850ms chu kỳ nào cũng trả):
  //   steady-state — L1 còn hạn (trạng thái phổ biến nhất của chu kỳ);
  //   L2 path      — process vừa restart (L1 rỗng, L2 còn hạn 10 phút);
  //   cold cycle   — sau invalidation/recompute: MỘT lần cho cả nhóm chu kỳ.
  await db.instrument.count(); // warm-up TLS pool (giống dev-server thật)
  await topByAdtv(10, { market: "HOSE", type: "STOCK" }); // lấp đầy cache

  // A1 steady-state: 8 lần gọi (mô hình 1 chu kỳ) — toàn bộ hit L1
  const steadyT0 = Date.now();
  const baskets: string[] = [];
  for (let i = 0; i < 8; i++) {
    baskets.push(JSON.stringify(await topByAdtv(10, { market: "HOSE", type: "STOCK" })));
  }
  const steadyMs = Date.now() - steadyT0;
  check(
    "A1 steady-state: 8 lần gọi/chu kỳ < 200ms (ngưỡng P0-3 — trước cache 750-850ms)",
    steadyMs < 200,
    `${steadyMs}ms (L1 hit)`
  );
  check("A2 ổn định rổ: 8 lần gọi GIỐNG HỆT (hợp đồng P0-2)", new Set(baskets).size === 1);

  // A1.1 — L2 path (mô phỏng restart process): xoá L1 → lần đầu đọc 1 query
  // từ bảng FeatureValue, 7 lần sau lại L1
  clearFeatureCacheL1();
  const l2T0 = Date.now();
  for (let i = 0; i < 8; i++) {
    await topByAdtv(10, { market: "HOSE", type: "STOCK" });
  }
  const l2CycleMs = Date.now() - l2T0;
  check(
    "A1.1 sau restart-process (L1 rỗng, L2 còn hạn): 8 lần gọi < 200ms",
    l2CycleMs < 200,
    `${l2CycleMs}ms (1 query L2 + 7 lần L1)`
  );

  // A1.2 — cold cycle (sau invalidation — 1 lần/10 phút hoặc sau eod-sync):
  // recompute 2 query + ghi L2 — vẫn phải DỨT KHOÁT tốt hơn 750-850ms chu kỳ
  // nào cũng trả (assert < 600ms = ngưỡng an toàn WAN chậm)
  await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX);
  const coldT0 = Date.now();
  for (let i = 0; i < 8; i++) {
    await topByAdtv(10, { market: "HOSE", type: "STOCK" });
  }
  const coldMs = Date.now() - coldT0;
  check(
    "A1.2 cold cycle sau invalidation: 8 lần gọi < 600ms (1 recompute/10' — tốt hơn 750-850ms MỖI chu kỳ)",
    coldMs < 600,
    `${coldMs}ms (recompute 2 query + ghi L2)`
  );

  // A3 — row L2 tồn tại, còn hạn, parse đúng
  const row = await db.featureValue.findUnique({ where: { key: KEY } });
  check("A3 row FeatureValue tồn tại (key topByAdtv:HOSE:STOCK:10)", row != null);
  if (row) {
    const parsed = JSON.parse(row.value) as { symbol: string; adtv: number; sessions: number }[];
    check(
      "A3.1 payload parse được 10 mã, expiresAt còn hạn",
      parsed.length === 10 && row.expiresAt.getTime() > Date.now(),
      `${parsed.length} mã · hết hạn sau ${(row.expiresAt.getTime() - Date.now()) / 1000}s`
    );
    check(
      "A3.2 mỗi mã đủ 45 phiên (ADTV_SESSIONS) — đúng hợp đồng §3.2",
      parsed.every((p) => p.sessions === 45),
      `sessions=${[...new Set(parsed.map((p) => p.sessions))].join(",")}`
    );
  }

  // A4 — L1 có key; xoá L1 (mô phỏng process mới) → đọc lại từ L2 (không tính lại)
  const stats = featureCacheStats();
  check("A4 L1 chứa key sau lần gọi", stats.l1Keys.includes(KEY), `l1Size=${stats.l1Size}`);
  clearFeatureCacheL1();
  const t2 = Date.now();
  const fromL2 = await topByAdtv(10, { market: "HOSE", type: "STOCK" });
  const l2Ms = Date.now() - t2;
  check(
    "A4.1 một lần đọc L2 (1 query ~RTT) nhanh hơn recompute (2 query)",
    l2Ms < 200,
    `L2 hit ${l2Ms}ms`
  );
  check("A4.2 rổ từ L2 giống hệt rổ vừa tính", JSON.stringify(fromL2) === baskets[0]);

  // A5 — force=true bỏ cache, tính thẳng từ DB → giống cached (đúng dữ liệu)
  const forced = await topByAdtv(10, { market: "HOSE", type: "STOCK", force: true });
  check(
    "A5 force=true (bypass cache) trả cùng rổ — cache không làm lệch dữ liệu",
    JSON.stringify(forced) === baskets[0],
    `top: ${forced.slice(0, 3).map((f) => f.symbol).join(",")}…`
  );

  // A6 — invalidation chủ động: xoá L1+L2 → gọi lại tái tạo row mới
  await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX);
  const afterInval = await db.featureValue.count({ where: { key: KEY } });
  check("A6 invalidate xoá row L2", afterInval === 0, `count=${afterInval}`);
  const cachedRaw = await cacheGetJson(KEY);
  check("A6.1 cacheGetJson sau invalidate trả null", cachedRaw == null);
  await topByAdtv(10, { market: "HOSE", type: "STOCK" });
  const recreated = await db.featureValue.findUnique({ where: { key: KEY } });
  check("A6.2 gọi lại tái tạo row FeatureValue mới", recreated != null);

  // A7 — điểm gắn invalidation trong MỌI đường ghi Bar (regression guard tĩnh)
  const eodSrc = fs.readFileSync("src/lib/eod-sync.ts", "utf8");
  const ceSrc = fs.readFileSync("src/lib/corporate-events.ts", "utf8");
  const tickSrc = fs.readFileSync("src/app/api/market/tick/route.ts", "utf8");
  const reprobeSrc = fs.readFileSync("src/app/api/market/reprobe/route.ts", "utf8");
  const intlSrc = fs.readFileSync("src/lib/intl-eod.ts", "utf8");
  check(
    "A7 MỌI đường ghi Bar đều invalidate cache (eod-sync · corporate-events · tick-sim · reprobe · intl-eod)",
    eodSrc.includes("invalidateFeatureCache") &&
      ceSrc.includes("invalidateFeatureCache") &&
      tickSrc.includes("invalidateFeatureCache") &&
      reprobeSrc.includes("invalidateFeatureCache") &&
      intlSrc.includes("invalidateFeatureCache")
  );

  // A7.1 (F-63A-06/#64 — guard mạnh hoá: includes() nói dối được nếu invalidate
  // nằm TRƯỚC phép ghi) — kiểm THỨ TỰ THEO BIÊN HÀM: mọi hàm chứa ghi Bar phải
  // có invalidateFeatureCache SAU ghi cuối cùng của chính hàm đó (cấp-file sẽ
  // false-positive khi một file có nhiều hàm ghi: eod-sync có syncEod +
  // deepBackfill, corporate-events có apply/reapply/reverse).
  const barWriteRe =
    /(?:db|tx)\.bar\.(?:upsert|create|createMany|update|updateMany|delete|deleteMany)/g;
  const fnStartRe = /^(?:export\s+)?(?:async\s+)?function\s+\w+/gm;
  const guardFiles: [string, string][] = [
    ["eod-sync.ts", eodSrc],
    ["corporate-events.ts", ceSrc],
    ["tick/route.ts", tickSrc],
    ["reprobe/route.ts", reprobeSrc],
    ["intl-eod.ts", intlSrc],
  ];
  for (const [name, srcRaw] of guardFiles) {
    // F-65B-08/#65 — strip comment trước phân tích: trước đây chuỗi
    // "invalidateFeatureCache" trong comment phía sau ghi cuối cũng thoả
    // check (false-pass). Sentinel đầu 0 (module scope): write nằm TRƯỚC
    // function declaration đầu không còn vô hình — thuộc "segment module"
    // và cũng phải có invalidate sau ghi cuối.
    const src = srcRaw
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    const starts: number[] = [];
    for (const m of src.matchAll(fnStartRe)) starts.push(m.index ?? 0);
    const bounds = [0, ...starts, src.length]; // sentinel 0 (module scope) + EOF
    let writeFns = 0;
    let badFns = 0;
    for (let i = 0; i < bounds.length - 1; i++) {
      const seg = src.slice(bounds[i], bounds[i + 1]);
      let lastWrite = -1;
      for (const m of seg.matchAll(barWriteRe)) lastWrite = Math.max(lastWrite, m.index ?? 0);
      if (lastWrite < 0) continue; // segment không ghi Bar — bỏ qua
      writeFns++;
      let hasAfter = false;
      for (const m of seg.matchAll(/invalidateFeatureCache/g)) {
        if ((m.index ?? 0) > lastWrite) {
          hasAfter = true;
          break;
        }
      }
      if (!hasAfter) badFns++;
    }
    check(
      `A7.1 ${name}: ${writeFns} hàm/segment ghi Bar đều có invalidate SAU ghi cuối (đã strip comment)`,
      badFns === 0 && writeFns > 0,
      badFns === 0 ? undefined : `${badFns} segment thiếu`
    );
  }
  // tick route: invalidation phải có gate barsWritten > 0 (chỉ xoá khi thật sự ghi)
  check(
    "A7.2 tick/route.ts: invalidation được gate `barsWritten > 0` (không bắn khi mode real không ghi bar)",
    tickSrc.includes("barsWritten > 0") &&
      tickSrc.indexOf("barsWritten > 0") < tickSrc.indexOf("await invalidateFeatureCache")
  );

  // A8 — dọn row FeatureValue cuối cùng (fixbug #63 F-63A-05): nguyên tắc
  // header hứa "dọn sạch … FeatureValue rows" nhưng trước fix A6.2 tái tạo
  // row rồi kết thúc — để lại row kiểm định trong bảng thật.
  await invalidateFeatureCache(TOPBYADTV_CACHE_PREFIX);
  const finalRows = await db.featureValue.count({
    where: { key: { startsWith: TOPBYADTV_CACHE_PREFIX } },
  });
  check("A8 dọn sạch row FeatureValue sau kiểm định (F-63A-05)", finalRows === 0, `count=${finalRows}`);
}

/* ═══════════════ B · P2-1 — Notify pending-egress ═══════════════ */

async function verifyNotify() {
  console.log("\n── B · P2-1 S1 webhook/email (pattern pending-egress) ──");
  const TEST_HOOK = "https://p2-verify-hook.invalid.local/trader";
  const TEST_EMAIL = "p2-verify@invalid.local";

  // B0 — cấu hình mặc định đọc được; lưu cấu hình test
  const before = await getNotifySettings();
  check("B0 getNotifySettings chạy (mặc định an toàn)", typeof before.enabled === "boolean");
  await saveNotifySettings({ enabled: true, webhookUrl: TEST_HOOK, emailTo: TEST_EMAIL });
  const cfg = await getNotifySettings();
  check(
    "B0.1 saveNotifySettings lưu đúng (enabled + webhook + email)",
    cfg.enabled === true && cfg.webhookUrl === TEST_HOOK && cfg.emailTo === TEST_EMAIL
  );

  // B1 — dispatch: webhook DNS hỏng → PENDING_EGRESS; email → PENDING_EGRESS
  const dispatched = await dispatchDigest({
    subject: "P2 verify — bản tin kiểm định",
    body: "Nội dung kiểm định P2-1 pending-egress",
    level: "PASS",
  });
  const webhookResult = dispatched.results.find((r) => r.channel === "WEBHOOK");
  const emailResult = dispatched.results.find((r) => r.channel === "EMAIL");
  check(
    "B1 webhook DNS lỗi → PENDING_EGRESS (không giả vờ đã gửi)",
    webhookResult?.status === "PENDING_EGRESS",
    `${webhookResult?.status} — ${webhookResult?.note.slice(0, 60)}`
  );
  check(
    "B1.1 email (sandbox không SMTP/egress) → PENDING_EGRESS",
    emailResult?.status === "PENDING_EGRESS"
  );

  // B2 — row outbox tồn tại đúng trạng thái
  const rows = await db.notificationOutbox.findMany({
    where: { target: { in: [TEST_HOOK, TEST_EMAIL] } },
  });
  check(
    "B2 row NotificationOutbox tạo đủ 2 kênh, status PENDING_EGRESS",
    rows.length === 2 && rows.every((r) => r.status === "PENDING_EGRESS"),
    `rows=${rows.length}`
  );
  check(
    "B2.1 attempts ≥ 1 + lastError có nội dung (trung thực)",
    rows.every((r) => r.attempts >= 1 && (r.lastError ?? "") !== "")
  );

  // B3 — retry sweep HERMETIC (fixbug #63 F-63B-02/F-63A-07): trước fix gọi
  // retryPendingOutbox(5) chọn 5 row PENDING_EGRESS cũ NHẤT TOÀN CỤC — khi
  // backlog demo ≥ 5, 2 row test (mới nhất) không thuộc top-5 → attempts
  // không tăng → false-negative 60/61 không tái lập được 61/61 của #62.
  // Sau fix F-63B-01 where đã filter WEBHOOK (EMAIL không còn chiếm slot);
  // ở đây đếm backlog webhook thật để chọn limit BAO TRÙM mọi row pending —
  // row test luôn nằm trong sweep bất kể trạng thái outbox toàn cục.
  const pendingWebhook = await db.notificationOutbox.count({
    where: { status: "PENDING_EGRESS", channel: "WEBHOOK" },
  });
  const retryLimit = Math.min(50, Math.max(5, pendingWebhook + 2));
  const retryOut = await retryPendingOutbox(retryLimit);
  const afterRetry = await db.notificationOutbox.findMany({
    where: { target: { in: [TEST_HOOK, TEST_EMAIL] } },
  });
  check(
    "B3 retryPendingOutbox thử lại (hermetic — limit bao trùm backlog, attempts tăng trên row test)",
    afterRetry.some((r) => r.channel === "WEBHOOK" && r.attempts >= 2),
    `pendingWebhook=${pendingWebhook} → limit=${retryLimit} · retried=${retryOut.retried}`
  );
  check(
    "B3.1 retry CHỈ quét WEBHOOK (F-63B-01) — row EMAIL test không được retry, không starve slot webhook",
    afterRetry.every((r) => r.channel !== "EMAIL" || r.attempts === 1),
    "EMAIL attempts giữ 1 (chờ SMTP — dead-letter không lấn slot)"
  );
  check(
    "B3.2 webhook DNS-lỗi vẫn PENDING_EGRESS — prune #63 (F-63B-11) chỉ xoá SENT/FAILED, backlog sống qua restart",
    afterRetry.some((r) => r.channel === "WEBHOOK" && r.status === "PENDING_EGRESS")
  );

  // B4 — listOutbox shape
  const listed = await listOutbox(20);
  check(
    "B4 listOutbox trả row JSON-safe cho UI (channel/target/status/attempts)",
    listed.every((r) => typeof r.channel === "string" && typeof r.attempts === "number")
  );

  // B5 — S1 wiring (regression guard tĩnh): runNotificationOfficer gọi dispatch
  const svcSrc = fs.readFileSync("src/lib/agent-service-runs.ts", "utf8");
  check(
    "B5 runNotificationOfficer gọi dispatchDigest + retryPendingOutbox (S1 wiring)",
    svcSrc.includes("dispatchDigest") && svcSrc.includes("retryPendingOutbox")
  );

  // B6 — dọn: tắt kênh + xoá row test (hết rác kiểm định trong bảng thật)
  await saveNotifySettings({ enabled: before.enabled, webhookUrl: before.webhookUrl, emailTo: before.emailTo });
  await db.notificationOutbox.deleteMany({ where: { target: { in: [TEST_HOOK, TEST_EMAIL] } } });
  const cleaned = await db.notificationOutbox.count({ where: { target: { in: [TEST_HOOK, TEST_EMAIL] } } });
  check("B6 dọn sạch: settings phục hồi + 0 row test", cleaned === 0);
}

/* ═══════════════ C · P2-2 — News reliability ═══════════════ */

async function verifyNewsReliability() {
  console.log("\n── C · P2-2 News source reliability (per-feed parse lỗi/tin trùng) ──");

  // C0 — baseline trước khi crawl
  const srcBefore = await db.dataSourceStatus.findUnique({ where: { key: "news" } });
  let baseline: Record<
    string,
    { runs: number; itemsSeen: number; duplicates: number; parseSkipped: number }
  > = {};
  if (srcBefore?.meta) {
    try {
      const meta = JSON.parse(srcBefore.meta) as {
        reliability?: Record<string, { runs: number; itemsSeen: number; duplicates: number; parseSkipped: number }>;
      };
      baseline = meta.reliability ?? {};
    } catch {
      baseline = {};
    }
  }

  // C1 — chạy ingest thật (5 feed RSS đã kiểm chứng từ môi trường này).
  // F-63C-08/#64: guard 60s nay ghép thêm lớp DB CAS cross-process (AppSetting
  // news-crawl-guard) — script này chạy tiến trình riêng KHÔNG trôi nổi tự do
  // nữa; {force:true} bypass cả 2 lớp để kiểm định luôn có 1 lần crawl thật
  // (route engine/UI vẫn đi đường guarded 429).
  const result = await ingestNews({ force: true });
  check(
    "C1 ingestNews chạy đủ 5 feed, mỗi feed có đủ trường thống kê P2-2",
    result.feeds.length === 5 &&
      result.feeds.every((f) => typeof f.skipped === "number" && typeof f.duplicates === "number")
  );
  for (const f of result.feeds) {
    if (f.ok) {
      check(
        `C1.1 ${f.name}: parsed+skipped khớp items (${f.parsed}+${f.skipped}=${f.items})`,
        (f.parsed ?? 0) + (f.skipped ?? 0) === f.items
      );
      check(
        `C1.2 ${f.name}: duplicates ≤ items (${f.duplicates}/${f.items})`,
        (f.duplicates ?? 0) <= f.items
      );
    } else {
      console.log(`  ⚠️ ${f.name} crawl lỗi lần này: ${f.error} — vẫn tích luỹ okRuns=false`);
    }
  }

  // C2 — reliability tích luỹ ghi vào DataSourceStatus meta (đủ 5 feed)
  const srcAfter = await db.dataSourceStatus.findUnique({ where: { key: "news" } });
  let reliability: Record<string, { runs: number; okRuns: number; itemsSeen: number; duplicates: number; parseSkipped: number; lastError: string | null }> = {};
  if (srcAfter?.meta) {
    try {
      const meta = JSON.parse(srcAfter.meta) as { reliability?: typeof reliability };
      reliability = meta.reliability ?? {};
    } catch {
      reliability = {};
    }
  }
  const feedNames = Object.keys(reliability);
  check(
    "C2 meta.reliability có đủ 5 feed tích luỹ",
    feedNames.length === 5,
    feedNames.join(", ").slice(0, 80)
  );
  for (const f of result.feeds) {
    const r = reliability[f.name];
    if (!r) continue;
    const base = baseline[f.name];
    check(
      `C2.1 ${f.name}: runs tăng đúng 1 (${base?.runs ?? 0}→${r.runs}) · itemsSeen cộng dồn (+${f.items})`,
      r.runs === (base?.runs ?? 0) + 1 && r.itemsSeen === (base?.itemsSeen ?? 0) + f.items
    );
    check(
      `C2.2 ${f.name}: duplicates tích luỹ đúng (+${f.duplicates ?? 0}) · parseSkipped (+${f.skipped ?? 0})`,
      r.duplicates === (base?.duplicates ?? 0) + (f.duplicates ?? 0) &&
        r.parseSkipped === (base?.parseSkipped ?? 0) + (f.skipped ?? 0)
    );
  }

  // C3 — kết quả ingest trả kèm reliability snapshot
  check(
    "C3 NewsIngestResult.reliability kèm snapshot sau lần chạy",
    result.reliability != null && Object.keys(result.reliability).length >= 5
  );
}

/* ═══════════════ D · P2-4 — Lịch giao dịch chính thức VN ═══════════════ */

async function verifyCalendar() {
  console.log("\n── D · P2-4 Lịch giao dịch chính thức VN + overlay runtime ──");

  // D0 — lớp tĩnh
  const dQK = new Date("2026-09-02T03:00:00Z"); // 10:00 ICT thứ 4 — Quốc khánh
  const dThu = new Date("2026-10-08T03:00:00Z"); // 10:00 ICT thứ 5 — ngày GD thường
  const dSat = new Date("2026-10-10T03:00:00Z"); // 10:00 ICT thứ 7
  check("D0 Quốc khánh 02/09/2026 → KHÔNG phiên (lớp tĩnh)", !(await isOfficialTradingDay(dQK)));
  check("D0.1 thứ 5 thường 08/10/2026 → CÓ phiên", await isOfficialTradingDay(dThu));
  check("D0.2 thứ 7 10/10/2026 → KHÔNG phiên", !(await isOfficialTradingDay(dSat)));
  // D0.3-D0.5 — regression fixbug #63 F-63C-01 (P1): trước fix lớp tĩnh
  // THIẾU 31/08 + 01/09 (HOSE/HNX nghỉ thật 31/8→2/9 do hoán đổi T2) và
  // THỪA 03/09 "nghỉ bù" (02/9 thứ Tư — không có bù; 03/9 giao dịch thật).
  const dQK0 = new Date("2026-08-31T03:00:00Z"); // 10:00 ICT thứ 2 — nghỉ hoán đổi
  const dQK1 = new Date("2026-09-01T03:00:00Z"); // 10:00 ICT thứ 3 — nghỉ liền
  const dQK3 = new Date("2026-09-03T03:00:00Z"); // 10:00 ICT thứ 4 — giao dịch trở lại
  check("D0.3 31/08/2026 nghỉ hoán đổi QK → KHÔNG phiên (F-63C-01)", !(await isOfficialTradingDay(dQK0)));
  check("D0.4 01/09/2026 nghỉ liền QK → KHÔNG phiên (F-63C-01)", !(await isOfficialTradingDay(dQK1)));
  check("D0.5 03/09/2026 → CÓ phiên (xoá 'nghỉ bù' sai — F-63C-01)", await isOfficialTradingDay(dQK3));

  // D1 — overlay runtime: thêm ngày nghỉ đột xuất
  await saveVnHolidayOverlay({ extra: ["2026-10-15"], remove: [] });
  check(
    "D1 overlay extra 15/10/2026 (thứ 5) → KHÔNG phiên ngay sau lưu",
    !(await isOfficialTradingDay(new Date("2026-10-15T03:00:00Z")))
  );

  // D1.1 — overlay remove: ngày lớp tĩnh sai được bỏ
  await saveVnHolidayOverlay({ extra: [], remove: ["2026-09-02"] });
  check(
    "D1.1 overlay remove 02/09/2026 → CÓ phiên (đã bỏ khỏi lịch)",
    await isOfficialTradingDay(new Date("2026-09-02T03:00:00Z"))
  );

  // D2 — khung nhìn lịch 1 tháng: 30/9 có Quốc khánh (trước remove ở D1.1 —
  // lưu lại trạng thái clean trước khi xem)
  await saveVnHolidayOverlay({ extra: ["2026-10-15"], remove: [] });
  const view = await officialCalendarView("2026-09-01", "2026-09-30");
  const qk = view.days.find((d) => d.date === "2026-09-02");
  check(
    "D2 officialCalendarView: 02/09/2026 đánh dấu nghỉ + tên lễ",
    qk?.trading === false && (qk?.holidayName ?? "").includes("Quốc khánh"),
    qk?.holidayName ?? ""
  );
  check(
    "D2.1 view không có ngày cuối tuần nào trading",
    view.days.filter((d) => d.source === "weekend").every((d) => !d.trading)
  );
  check(
    "D2.2 overlay kèm theo view (extra=[2026-10-15])",
    view.overlay.extra.includes("2026-10-15")
  );

  // D3 — upcomingHolidays sắp xếp tăng theo ngày, ≥ hôm nay
  const up = await upcomingHolidays(6);
  const today = ictNow().date;
  check(
    "D3 upcomingHolidays: 6 ngày sắp tới tăng dần, ≥ hôm nay",
    up.length === 6 && up.every((h) => h.date >= today) &&
      up.every((h, i) => i === 0 || h.date >= up[i - 1].date),
    up.map((h) => h.date).join(", ")
  );

  // D4 — E2E A9: overlay hôm nay (nếu hôm nay là ngày GD) lật ghi chú
  // freshness của verdict ("ngoài ngày giao dịch") — chứng minh A9 dùng lịch
  // chính thức + overlay, không còn suy từ union Bar
  const todayTrading = await isOfficialTradingDay(new Date());
  if (todayTrading) {
    await saveVnHolidayOverlay({ extra: [today], remove: [] });
    const verdictOverlay = await runDataQualityChecks();
    const fresh = verdictOverlay.checks.find((c) => c.kind === "freshness");
    check(
      "D4 A9 dùng overlay: hôm nay bị khai báo nghỉ → freshness ghi 'ngoài ngày giao dịch'",
      (fresh?.detail ?? "").includes("ngoài ngày giao dịch"),
      (fresh?.detail ?? "").slice(0, 90)
    );
  } else {
    console.log("  ⚠️ D4 bỏ qua — hôm nay không phải ngày giao dịch (không lật được ghi chú)");
  }

  // D5 — dọn overlay → phục hồi trạng thái sạch
  await saveVnHolidayOverlay({ extra: [], remove: [] });
  const overlayClean = await getVnHolidayOverlay();
  const qkAgain = !(await isOfficialTradingDay(dQK));
  check(
    "D5 dọn overlay: extra/remove rỗng + 02/09/2026 lại là ngày nghỉ",
    overlayClean.extra.length === 0 && overlayClean.remove.length === 0 && qkAgain
  );

  // D6 — điểm gắn A9 (regression guard tĩnh)
  const dqSrc = fs.readFileSync("src/lib/data-quality.ts", "utf8");
  check(
    "D6 data-quality.ts dùng isOfficialTradingDay (A9 wiring P2-4)",
    dqSrc.includes("isOfficialTradingDay")
  );
}

/* ═══════════════ Chạy toàn bộ ═══════════════ */

async function main() {
  console.log("════ KIỂM ĐỊNH GÓI P2 — DATA_PLATFORM_BLUEPRINT v1.7 §5 (phiên #62 + fixbug #63) ════");
  await verifyFeatureCache();
  await verifyNotify();
  await verifyNewsReliability();
  await verifyCalendar();
  console.log(`\n════ KẾT QUẢ: ${pass}/${pass + fail} PASS ════`);
  await db.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error("LỖI script:", err);
  await db.$disconnect().catch(() => undefined);
  process.exit(1);
});
