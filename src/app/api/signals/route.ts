import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/signals — recent trading signals with instrument + agent info.
 */
export async function GET() {
  try {
    const signals = await db.signal.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      include: {
        instrument: { select: { symbol: true, name: true } },
        agent: { select: { code: true, name: true } },
      },
    });

    return NextResponse.json(
      toPlain({
        signals: signals.map((s) => ({
          id: s.id,
          symbol: s.instrument.symbol,
          name: s.instrument.name,
          direction: s.direction,
          confidence: s.confidence,
          score: s.score,
          rationale: s.rationale,
          targetPrice: s.targetPrice,
          stopLoss: s.stopLoss,
          takeProfit: s.takeProfit,
          agentName: s.agent?.name ?? null,
          agentCode: s.agent?.code ?? null,
          actedAt: s.actedAt,
          expiresAt: s.expiresAt,
          createdAt: s.createdAt,
        })),
      })
    );
  } catch (err) {
    console.error("[api/signals]", err);
    return NextResponse.json(
      { error: "Không tải được tín hiệu giao dịch." },
      { status: 500 }
    );
  }
}
