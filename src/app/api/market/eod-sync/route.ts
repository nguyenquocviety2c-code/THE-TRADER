import { NextRequest, NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { syncEodFromDchart, deepBackfillEod } from "@/lib/eod-sync";
import { runPostIngestChecks } from "@/lib/ingest-pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/market/eod-sync — kéo bar EOD THẬT từ VNDIRECT dchart và neo
 * Quote vào mức đóng cửa thật (src/lib/eod-sync.ts).
 *
 * Body (tuỳ chọn):
 *   { days?: number }        — lookback mặc định 10 ngày (đủ che T7/CN/lễ),
 *                              tối đa 365. Được market-engine gọi mỗi ngày
 *                              15:45 ICT và có thể trigger thủ công.
 *   { force?: "deep" }       — F-611B-03/#61: deep backfill 2013→nay (đường
 *                              nạp #2 trong INGEST_REGISTRY — trước đây registry
 *                              khai báo `?force=deep` nhưng route không nhận →
 *                              operator gọi theo registry được sync thường 10
 *                              ngày mà tưởng đã backfill sâu). Giữ PIT theo
 *                              F-611B-04 (firstSeenAt cũ được tôn trọng).
 *
 * P1-6 (phiên #60 — pipeline nạp một cửa): SAU upsert, route chạy CHUỖN HẬU
 * KIỂM CHUNG (runPostIngestChecks): A9-check thuần outlier/gap/split (cùng
 * hàm scanOutlierBars với chu kỳ A9) + CorporateEvent scan tự điều chỉnh
 * (P1-1) — kết quả gắn trong response.postCheck (engine broadcast tiếp qua
 * WS như mọi job khác). Cross-check finfo vs dchart (P1-3) + value
 * re-validate chạy BÊN TRONG syncEodFromDchart (ảnh Quote chụp trước anchor
 * — F-611B-01/#61).
 *
 * F-611B-02/#61 — mutex in-process (pattern F-441-01 của intl-sync): maxDuration
 * route là 300s và hậu kiểm nặng (scan 2× + A9 re-run) — POST chồng lấn trong
 * lúc chạy sẽ quét/d coordinate song song trên cùng bảng Bar. Đang chạy → 429.
 *
 * Response: EodSyncOutcome { ok, symbolsOk[], symbolsEmpty[], symbolsFailed[],
 * barsUpserted, barsSkipped, lastTradeDate, durationMs, crossCheck,
 * valueMismatches } + postCheck (P1-6) + days|force.
 */
let inFlight = false;

export async function POST(req: NextRequest) {
  if (inFlight) {
    return NextResponse.json(
      { error: "Đồng bộ EOD đang chạy (mutex F-611B-02) — vui lòng đợi hoàn tất." },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  inFlight = true;
  try {
    const body = (await req.json().catch(() => ({}))) as { days?: unknown; force?: unknown };
    const force = body.force === "deep" ? "deep" : undefined;
    const days =
      typeof body.days === "number" && Number.isFinite(body.days)
        ? Math.max(2, Math.min(365, Math.floor(body.days)))
        : 10;

    const outcome = force === "deep"
      ? await deepBackfillEod({ fromYear: 2013 })
      : await syncEodFromDchart({ lookbackDays: days });

    // P1-6 — hậu kiểm một cửa cho các mã vừa nạp (fail-soft: lỗi hậu kiểm
    // KHÔNG làm hỏng sync — bar đã upsert idempotent an toàn)
    const postCheck = await runPostIngestChecks({
      route: force === "deep" ? "eod-sync-deep" : "eod-sync",
      instrumentIds: undefined, // toàn bộ VN active — corporate scan cần rổ đầy đủ
    }).catch((err) => {
      console.error("[api/market/eod-sync] postIngestChecks lỗi (bỏ qua):", err);
      return null;
    });

    return NextResponse.json(
      toPlain(
        postCheck
          ? { ...outcome, ...(force ? { force } : { days }), postCheck }
          : { ...outcome, ...(force ? { force } : { days }) }
      ),
      {
        status: outcome.ok ? 200 : 502,
      }
    );
  } catch (err) {
    console.error("[api/market/eod-sync]", err);
    return NextResponse.json(
      { error: "Đồng bộ EOD thật thất bại — xem log server để biết chi tiết." },
      { status: 500 }
    );
  } finally {
    inFlight = false;
  }
}
