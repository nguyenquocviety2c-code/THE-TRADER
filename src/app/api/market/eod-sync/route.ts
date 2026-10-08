import { NextRequest, NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { syncEodFromDchart } from "@/lib/eod-sync";
import { runPostIngestChecks } from "@/lib/ingest-pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/market/eod-sync — kéo bar EOD THẬT từ VNDIRECT dchart và neo
 * Quote vào mức đóng cửa thật (src/lib/eod-sync.ts).
 *
 * Body (tuỳ chọn): { days?: number } — lookback mặc định 10 ngày (đủ che
 * T7/CN/lễ), tối đa 365. Được market-engine gọi mỗi ngày 15:45 ICT và có thể
 * trigger thủ công.
 *
 * P1-6 (phiên #60 — pipeline nạp một cửa): SAU upsert, route chạy CHUỖN HẬU
 * KIỂM CHUNG (runPostIngestChecks): A9-check thuần outlier/gap/split (cùng
 * hàm scanOutlierBars với chu kỳ A9) + CorporateEvent scan tự điều chỉnh
 * (P1-1) — kết quả gắn trong response.postCheck (engine broadcast tiếp qua
 * WS như mọi job khác). Cross-check finfo vs dchart (P1-3) + value
 * re-validate chạy BÊN TRONG syncEodFromDchart (cần ảnh Quote trước anchor).
 *
 * Response: EodSyncOutcome { ok, symbolsOk[], symbolsEmpty[], symbolsFailed[],
 * barsUpserted, barsSkipped, lastTradeDate, durationMs, crossCheck,
 * valueMismatches } + postCheck (P1-6).
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { days?: unknown };
    const days =
      typeof body.days === "number" && Number.isFinite(body.days)
        ? Math.max(2, Math.min(365, Math.floor(body.days)))
        : 10;

    const outcome = await syncEodFromDchart({ lookbackDays: days });

    // P1-6 — hậu kiểm một cửa cho các mã vừa nạp (fail-soft: lỗi hậu kiểm
    // KHÔNG làm hỏng sync — bar đã upsert idempotent an toàn)
    const postCheck = await runPostIngestChecks({
      route: "eod-sync",
      instrumentIds: undefined, // toàn bộ VN active — corporate scan cần rổ đầy đủ
    }).catch((err) => {
      console.error("[api/market/eod-sync] postIngestChecks lỗi (bỏ qua):", err);
      return null;
    });

    return NextResponse.json(
      toPlain(postCheck ? { ...outcome, days, postCheck } : { ...outcome, days }),
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
  }
}
