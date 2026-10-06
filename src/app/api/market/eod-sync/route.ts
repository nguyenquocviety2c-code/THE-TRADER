import { NextRequest, NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { syncEodFromDchart } from "@/lib/eod-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/market/eod-sync — kéo bar EOD THẬT từ VNDIRECT dchart và neo
 * Quote vào mức đóng cửa thật (src/lib/eod-sync.ts).
 *
 * Body (tuỳ chọn): { days?: number } — lookback mặc định 10 ngày (đủ che
 * T7/CN/lễ), tối đa 365. Được market-engine gọi mỗi ngày 15:45 ICT và có thể
 * trigger thủ công.
 *
 * Response: EodSyncOutcome { ok, symbolsOk[], symbolsEmpty[], symbolsFailed[],
 * barsUpserted, barsSkipped, lastTradeDate, durationMs }.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { days?: unknown };
    const days =
      typeof body.days === "number" && Number.isFinite(body.days)
        ? Math.max(2, Math.min(365, Math.floor(body.days)))
        : 10;

    const outcome = await syncEodFromDchart({ lookbackDays: days });
    return NextResponse.json(toPlain({ ...outcome, days }), {
      status: outcome.ok ? 200 : 502,
    });
  } catch (err) {
    console.error("[api/market/eod-sync]", err);
    return NextResponse.json(
      { error: "Đồng bộ EOD thật thất bại — xem log server để biết chi tiết." },
      { status: 500 }
    );
  }
}
