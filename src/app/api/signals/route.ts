import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { mapSignalRow } from "@/lib/signal-execution";

export const dynamic = "force-dynamic";

/**
 * GET /api/signals — recent trading signals with instrument + agent info.
 * PHASE3 B2 §4.1: map thêm status / rejectedAt / rejectNote.
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
        signals: signals.map(mapSignalRow),
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
