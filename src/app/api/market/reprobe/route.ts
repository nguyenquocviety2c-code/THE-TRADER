import { NextRequest, NextResponse } from "next/server";
import type { InstrumentType, Market } from "@prisma/client";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import {
  fetchDchartHistory,
  toRealBars,
  anchorQuoteToRealEod,
  resolveUnitSpec,
} from "@/lib/eod-sync";
import { runPostIngestChecks } from "@/lib/ingest-pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/market/reprobe (B14/T1 — MARKET_EXPANSION_BLUEPRINT v1.1 §1.2) —
 * WATCHER RE-PROBE TUẦN danh sách ứng viên các ô ⚪/🟡 của ma trận độ phủ.
 *
 * Mỗi Chủ nhật 04:00 ICT market-engine sẽ gọi route này (orchestrator wiring
 * job — route chỉ cung cấp HTTP entry, idempotent an toàn chạy lại bất cứ lúc
 * nào). Hoá tiêu chí T1 §1.1: "watcher re-probe tuần tự nạp khi mã đầu tiên
 * xuất hiện dữ liệu" — probe-trước-khi-tạo như B3 (expand-universe.ts), KHÔNG
 * tạo instrument chết.
 *
 * Danh sách ứng viên chuẩn (Appendix A + dự phòng — hardcoded, body có thể
 * override để chạy thử tập con):
 *   • FUND HOSE/HNX/UPCOM : VF1 · VFMVF1 · VFF · PRBF · BF1 (probe 2026-10-07
 *     = rỗng — thử lại tuần nào tới khi quỹ đóng niêm yết trở lại)
 *   • ETF HNX             : E1VFVN30 · FUEVFVND · FUESSVFL · FUEVN100 ·
 *     FUEIP100 (thử lại — hiện 0 ETF HNX; 5 mã này đã tồn tại như HOSE:ETF
 *     → skip idempotent theo symbol unique toàn cục)
 *   • UPCOM (ứng viên đã bỏ + dự phòng): SME · KLF · V11 · TUE · VFS · C92 ·
 *     CRE · IDC
 *   • BOND: KHÔNG probe (để sau — chưa có nguồn công khai, không probe dchart)
 *
 * Luồng mỗi ứng viên CHƯA tồn tại trong Instrument:
 *   1. probe dchart 60 ngày (fetchDchartHistory — throttle 300ms chia sẻ
 *      module với eod-sync, tôn trọng nguồn công cộng);
 *   2. CÓ dữ liệu hợp lệ (toRealBars ≥ 1 bar) → tạo Instrument đúng
 *      (market/type từ danh sách, currency VND) + DEEP BACKFILL RIÊNG mã đó:
 *      fetch range dài 2013→nay → toRealBars → createMany chunk 1000 →
 *      anchorQuoteToRealEod (đối xứng eod-sync.ts, KHÔNG dùng deepBackfillEod
 *      vì hàm đó quét toàn bộ universe);
 *      nếu fetch deep lỗi mạng → fallback chèn bar của chính lượt probe 60
 *      ngày (mã không bị trọc — bar đầy đủ sẽ tự bổ sung bởi eod-sync 15:45 ICT);
 *   3. trống → bỏ + log (minh bạch trong response `empty`).
 *
 * Idempotent: mã đã tồn tại trong Instrument (kể cả inactive) → skip, đếm
 * skippedExisting. Cooldown 60s giữa 2 lần gọi → 429 + Retry-After.
 *
 * Response: { probed, created, skippedExisting, empty, failed, barsCreated,
 * durationMs }.
 */

const COOLDOWN_MS = 60_000;
let lastRunAt = 0;

/** Ứng viên watcher — market/type gán theo niêm yết lịch sử của mã. */
interface ReprobeCandidate {
  symbol: string;
  market: Market;
  type: InstrumentType;
  cell: string; // ô ma trận mà ứng viên thắp sáng khi có dữ liệu
}

/** Danh sách ứng viên chuẩn (Appendix A + dự phòng — §B14 v1.1). */
const DEFAULT_CANDIDATES: ReprobeCandidate[] = [
  // FUND — quỹ đóng 3 sàn (probe 2026-10-07 rỗng, thử lại hằng tuần)
  { symbol: "VF1", market: "HOSE", type: "FUND", cell: "HOSE×FUND" },
  { symbol: "VFMVF1", market: "HOSE", type: "FUND", cell: "HOSE×FUND" },
  { symbol: "VFF", market: "HOSE", type: "FUND", cell: "HOSE×FUND" },
  { symbol: "PRBF", market: "HOSE", type: "FUND", cell: "HOSE×FUND" },
  { symbol: "BF1", market: "HNX", type: "FUND", cell: "HNX×FUND" },
  // ETF HNX — thử lại (5 mã đã tồn tại HOSE:ETF → skip idempotent)
  { symbol: "E1VFVN30", market: "HNX", type: "ETF", cell: "HNX×ETF" },
  { symbol: "FUEVFVND", market: "HNX", type: "ETF", cell: "HNX×ETF" },
  { symbol: "FUESSVFL", market: "HNX", type: "ETF", cell: "HNX×ETF" },
  { symbol: "FUEVN100", market: "HNX", type: "ETF", cell: "HNX×ETF" },
  { symbol: "FUEIP100", market: "HNX", type: "ETF", cell: "HNX×ETF" },
  // UPCOM — ứng viên probe trống lúc B3 + dự phòng
  { symbol: "SME", market: "UPCOM", type: "STOCK", cell: "UPCOM×STOCK" },
  { symbol: "KLF", market: "UPCOM", type: "STOCK", cell: "UPCOM×STOCK" },
  { symbol: "V11", market: "UPCOM", type: "STOCK", cell: "UPCOM×STOCK" },
  { symbol: "TUE", market: "UPCOM", type: "STOCK", cell: "UPCOM×STOCK" },
  { symbol: "VFS", market: "UPCOM", type: "STOCK", cell: "UPCOM×STOCK" },
  { symbol: "C92", market: "UPCOM", type: "STOCK", cell: "UPCOM×STOCK" },
  { symbol: "CRE", market: "UPCOM", type: "STOCK", cell: "UPCOM×STOCK" },
  { symbol: "IDC", market: "UPCOM", type: "STOCK", cell: "UPCOM×STOCK" },
  // BOND — KHÔNG probe (chưa có nguồn xác minh; dchart không có trái phiếu)
];

/** Deep backfill riêng 1 mã mới — trả số bar đã chèn (0 khi trống). */
async function backfillSingleSymbol(
  candidate: ReprobeCandidate,
  probeBars: ReturnType<typeof toRealBars>["bars"],
  instrumentId: string
): Promise<number> {
  const unit = resolveUnitSpec(candidate.market, candidate.type);
  const fromSec = Math.floor(Date.UTC(2013, 0, 1) / 1000);
  const toSec = Math.floor(Date.now() / 1000) + 86_400; // +1 ngày chặn biên

  let bars = probeBars; // fallback: bar của chính lượt probe 60 ngày
  try {
    const deep = await fetchDchartHistory({
      symbol: candidate.symbol,
      fromUnixSec: fromSec,
      toUnixSec: toSec,
      timeoutMs: 30_000,
    });
    if (!deep.empty) {
      const converted = toRealBars(candidate.symbol, deep.bars, unit);
      if (converted.bars.length > 0) bars = converted.bars;
    }
  } catch (err) {
    // Deep fetch lỗi (mạng/429) → giữ bar probe 60 ngày; lịch sử đầy đủ sẽ
    // tự bổ sung bởi eod-sync hằng ngày 15:45 ICT — mã không bị "trọc".
    console.warn(
      `[api/market/reprobe] deep backfill ${candidate.symbol} lỗi — dùng bar probe 60 ngày:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  if (bars.length === 0) return 0;
  // P1-2 — đồng hồ mốc backfill mã mới (PIT firstSeenAt/lastSyncedAt)
  const syncAt = new Date();
  // Instrument vừa tạo → 0 bar cũ, createMany thẳng (chunk 1000 như eod-sync)
  for (let i = 0; i < bars.length; i += 1000) {
    const chunk = bars.slice(i, i + 1000);
    await db.bar.createMany({
      data: chunk.map((b) => ({
        instrumentId,
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        value: b.value,
        firstSeenAt: syncAt,
        lastSyncedAt: syncAt,
      })),
    });
  }
  await anchorQuoteToRealEod(instrumentId, bars, unit);
  return bars.length;
}

export async function POST(req: NextRequest) {
  const now = Date.now();
  const sinceLast = now - lastRunAt;
  if (sinceLast < COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
    return NextResponse.json(
      {
        error: `Watcher re-probe vừa chạy cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi ${retryAfterSeconds}s rồi thử lại.`,
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      }
    );
  }

  // Body { candidates?: string[] } — override tập con danh sách chuẩn.
  // Mã ngoài registry → 400 kèm danh sách hợp lệ (không đoán mò market/type).
  let candidates: ReprobeCandidate[] = DEFAULT_CANDIDATES;
  try {
    const body = (await req.json()) as { candidates?: unknown } | null;
    if (body && Array.isArray(body.candidates)) {
      const requested = body.candidates
        .filter((s): s is string => typeof s === "string" && s.length > 0)
        .map((s) => s.trim().toUpperCase());
      if (requested.length === 0) {
        return NextResponse.json(
          { error: "candidates rỗng — truyền mảng symbol hoặc bỏ body để dùng danh sách chuẩn." },
          { status: 400 }
        );
      }
      const byUpper = new Map(
        DEFAULT_CANDIDATES.map((c) => [c.symbol.toUpperCase(), c])
      );
      const unknown = requested.filter((s) => !byUpper.has(s));
      if (unknown.length > 0) {
        return NextResponse.json(
          {
            error: `Ứng viên không nằm trong danh sách watcher: ${unknown.join(", ")}. Danh sách hợp lệ: ${DEFAULT_CANDIDATES.map((c) => c.symbol).join(", ")}.`,
          },
          { status: 400 }
        );
      }
      // Giữ thứ tự registry, bỏ trùng lặp
      candidates = DEFAULT_CANDIDATES.filter((c) =>
        requested.includes(c.symbol.toUpperCase())
      );
    }
  } catch {
    // body rỗng / JSON hỏng → dùng danh sách chuẩn
  }

  lastRunAt = now;
  const startedAt = Date.now();

  try {
    // 1 query tồn tại — idempotent theo symbol unique toàn cục (kể cả inactive)
    const existing = new Set(
      (
        await db.instrument.findMany({
          select: { symbol: true },
        })
      ).map((i) => i.symbol)
    );

    let skippedExisting = 0;
    const created: string[] = [];
    const empty: string[] = [];
    const failed: { symbol: string; error: string }[] = [];
    let barsCreated = 0;

    for (const c of candidates) {
      if (existing.has(c.symbol)) {
        skippedExisting++;
        continue; // idempotent — mã đã có trong universe
      }
      try {
        // Probe 60 ngày — probe-trước-khi-tạo (B3), throttle 300ms chia sẻ eod-sync
        const toSec = Math.floor(Date.now() / 1000) + 86_400;
        const probe = await fetchDchartHistory({
          symbol: c.symbol,
          fromUnixSec: toSec - 60 * 86_400,
          toUnixSec: toSec,
          timeoutMs: 15_000,
        });
        if (probe.empty) {
          empty.push(c.symbol);
          console.log(
            `[api/market/reprobe] ⚪ BỎ ${c.symbol} (${c.cell}) — probe dchart trống`
          );
          continue;
        }
        const unit = resolveUnitSpec(c.market, c.type);
        const probeConverted = toRealBars(c.symbol, probe.bars, unit);
        if (probeConverted.bars.length === 0) {
          empty.push(c.symbol);
          console.log(
            `[api/market/reprobe] ⚪ BỎ ${c.symbol} (${c.cell}) — probe có dữ liệu nhưng 0 bar hợp lệ`
          );
          continue;
        }

        // CÓ dữ liệu → tạo Instrument + deep backfill riêng mã
        const inst = await db.instrument.create({
          data: {
            symbol: c.symbol,
            name: `${c.symbol} (${c.market})`, // tên đầy đủ chưa xác minh — pattern expand-universe.ts
            market: c.market,
            type: c.type,
            sector: "Khác",
            currency: "VND",
            isActive: true,
          },
        });
        existing.add(c.symbol);
        const inserted = await backfillSingleSymbol(c, probeConverted.bars, inst.id);
        barsCreated += inserted;
        created.push(c.symbol);
        console.log(
          `[api/market/reprobe] ✅ TẠO ${c.symbol} (${c.cell}) — ${inserted} bar EOD thật`
        );
      } catch (err) {
        failed.push({
          symbol: c.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(
          `[api/market/reprobe] ❌ LỖI ${c.symbol} (${c.cell}):`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    const probed = candidates.length - skippedExisting;
    // P1-6 — hậu kiểm một cửa cho MÃ VỪA TẠO (created) — A9-check +
    // CorporateEvent scan trên chuỗi backfill mới (fail-soft)
    let postCheck: Awaited<ReturnType<typeof runPostIngestChecks>> | null = null;
    if (created.length > 0) {
      const createdRows = await db.instrument
        .findMany({ where: { symbol: { in: created } }, select: { id: true } })
        .catch(() => [] as { id: string }[]);
      postCheck = await runPostIngestChecks({
        route: "reprobe",
        instrumentIds: createdRows.map((r) => r.id),
      }).catch((err) => {
        console.error("[api/market/reprobe] postIngestChecks lỗi (bỏ qua):", err);
        return null;
      });
    }
    return NextResponse.json(
      toPlain({
        probed,
        created,
        skippedExisting,
        empty,
        failed,
        barsCreated,
        durationMs: Date.now() - startedAt,
        ...(postCheck ? { postCheck } : {}),
      })
    );
  } catch (err) {
    // Cho phép retry ngay khi lỗi hệ thống (không giữ cooldown vô ích)
    lastRunAt = 0;
    console.error("[api/market/reprobe] POST failed:", err);
    return NextResponse.json(
      { error: "Watcher re-probe thất bại — xem log server để biết chi tiết." },
      { status: 500 }
    );
  }
}
