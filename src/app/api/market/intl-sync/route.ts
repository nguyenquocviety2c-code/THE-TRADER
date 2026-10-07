import { NextRequest, NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { db } from "@/lib/db";
import {
  syncIntlEod,
  INTL_RANGES,
  DEFAULT_INTL_RANGE,
} from "@/lib/intl-eod";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/market/intl-sync — kéo bar EOD QUỐC TẾ (US/HK) từ Yahoo Finance
 * v8 chart (src/lib/intl-eod.ts — Bước 12) và neo Quote theo UnitSpec
 * (STOCK/ETF → cents ×100 · INDEX → điểm ×100 · KHÔNG trần/sàn ±7%).
 *
 * Body (tuỳ chọn): { range?: string } — whitelist 5d|1mo|3mo|6mo|1y|2y|auto,
 * mặc định "auto": universe quốc tế chưa có bar → "1y" (backfill lần đầu),
 * đã có → "5d" (đủ cho sync hằng ngày 06:15 ICT). Sai whitelist → 400.
 * Được market-engine gọi 06:15 ICT (sau đóng cửa Mỹ — orchestrator thêm job)
 * và có thể trigger thủ công. Cooldown 30s giữa 2 lần gọi → 429 kèm
 * Retry-After (pattern /api/assessment/synthesize + /api/ml/train).
 *
 * Response: IntlSyncOutcome (kèm durationMs) + range + note khi universe
 * US/HK chưa seed (0 instrument match — ok=true với 0 mã, hướng dẫn chạy
 * prisma/expand-universe.ts --intl trước).
 */
const COOLDOWN_MS = 30_000;
let lastSyncAt = 0;

/** F-441-01 (#44) — mutex in-process: 1 sync chạy tại 1 thời điểm.
 * Trước đây cooldown tính từ lúc BẮT ĐẦU request nên caller cách 60s vẫn lọt
 * qua trong khi lần cũ chưa xong (route ~2-3 phút) → nhiều sync chồng lấn
 * cùng đấm Yahoo 429. Kể từ #44: request mới khi sync đang chạy → 429 ngay. */
let inFlight = false;

export async function POST(req: NextRequest) {
  const now = Date.now();
  if (inFlight) {
    return NextResponse.json(
      { error: "Đồng bộ EOD quốc tế đang chạy (mutex F-441-01) — vui lòng đợi hoàn tất." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  const sinceLast = now - lastSyncAt;
  if (sinceLast < COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
    return NextResponse.json(
      {
        error: `Đồng bộ EOD quốc tế vừa chạy cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi ${retryAfterSeconds}s rồi thử lại.`,
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      }
    );
  }

  // Body { range } — tolerant: body rỗng/JSON hỏng dùng default "auto"
  let range: string = "auto";
  try {
    const body = (await req.json()) as { range?: unknown } | null;
    if (body && typeof body.range === "string" && body.range.length > 0) {
      range = body.range;
    }
  } catch {
    // body rỗng — giữ default
  }
  // "auto": chưa có bar quốc tế → backfill "1y"; đã có → "5d" (B12 job 06:15)
  if (range === "auto") {
    const intlBars = await db.bar
      .count({
        where: { instrument: { market: { in: ["US", "HK"] } } },
      })
      .catch(() => 0);
    range = intlBars > 0 ? "5d" : DEFAULT_INTL_RANGE;
  }
  if (!INTL_RANGES.includes(range)) {
    return NextResponse.json(
      { error: `range "${range}" không hợp lệ (${INTL_RANGES.join(" | ")} | auto).` },
      { status: 400 }
    );
  }

  lastSyncAt = now;
  inFlight = true;
  try {
    const outcome = await syncIntlEod({ range });
    // Cooldown tính từ lúc HOÀN THÀNH (F-441-01) — không phải lúc bắt đầu
    lastSyncAt = Date.now();
    // Universe US/HK chưa seed (0 mã ok + 0 mã lỗi) → kèm note hướng dẫn
    // (outcome vẫn ok=true — hợp lệ, không phải lỗi hệ thống)
    const note =
      outcome.symbolsOk.length === 0 && outcome.symbolsFailed.length === 0
        ? "Chạy prisma/expand-universe.ts --intl để seed universe US/HK trước"
        : undefined;
    return NextResponse.json(toPlain(note ? { ...outcome, note } : outcome), {
      status: outcome.ok ? 200 : 502,
    });
  } catch (err) {
    // Lỗi hệ thống (throw) — cho phép retry ngay, không giữ cooldown vô ích
    lastSyncAt = 0;
    console.error("[api/market/intl-sync] POST failed:", err);
    return NextResponse.json(
      { error: "Đồng bộ EOD quốc tế thất bại — xem log server để biết chi tiết." },
      { status: 500 }
    );
  } finally {
    inFlight = false;
  }
}
