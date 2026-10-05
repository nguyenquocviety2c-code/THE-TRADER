import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { escalateStaleSources, readSources, staleOf } from "@/lib/sources";
import { getTradingMode, TRADING_MODE_LABEL } from "@/lib/trading-mode";
import { sessionPhase, SESSION_PHASE_LABEL, isTradingSession } from "@/lib/market-session";

export const dynamic = "force-dynamic";

/**
 * GET /api/system/status — tổng hợp trạng thái toàn hệ thống cho footer
 * và panel monitoring (S4 stale marking + S3 trading mode):
 *   - sources[]: mỗi nguồn → mode + stale + tuổi lần thành công cuối
 *   - trading: paper | live | live-unconfigured
 *   - counts: quy mô dữ liệu hiện có
 * Gọi kèm escalateStaleSources() (§6.4 DATA_SOURCES) trước khi đọc.
 */
export async function GET() {
  try {
    const escalated = await escalateStaleSources();
    const [sources, newsCount, signalCount, orderCount, messageCount] =
      await Promise.all([
        readSources(),
        db.newsItem.count(),
        db.signal.count(),
        db.order.count(),
        db.agentMessage.count(),
      ]);

    const trading = getTradingMode();

    return NextResponse.json({
      sources: sources.map((s) => {
        const { stale, ageMinutes } = staleOf(s);
        return {
          key: s.key,
          label: s.label,
          mode: s.mode,
          stale,
          ageMinutes,
          lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
          lastError: s.lastError,
          providers: (s.meta?.providers as string[] | undefined) ?? [],
          updatedAt: s.updatedAt.toISOString(),
        };
      }),
      trading: {
        ...trading,
        label: TRADING_MODE_LABEL[trading.mode],
      },
      market: {
        phase: sessionPhase(new Date()),
        phaseLabel: SESSION_PHASE_LABEL[sessionPhase(new Date())],
        inSession: isTradingSession(new Date()),
        strictSession: process.env.MARKET_STRICT_SESSION === "true",
      },
      counts: {
        news: newsCount,
        signals: signalCount,
        orders: orderCount,
        agentMessages: messageCount,
      },
      escalatedAlerts: escalated,
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[api/system/status]", err);
    return NextResponse.json(
      { error: "Không tải được trạng thái hệ thống." },
      { status: 500 }
    );
  }
}
