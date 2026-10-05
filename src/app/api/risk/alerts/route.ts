import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/risk/alerts — 10 most recent risk alerts.
 */
export async function GET() {
  try {
    const alerts = await db.riskAlert.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    return NextResponse.json(
      toPlain({
        alerts: alerts.map((a) => ({
          id: a.id,
          severity: a.severity,
          code: a.code,
          message: a.message,
          metricKey: a.metricKey,
          metricValue: a.metricValue,
          threshold: a.threshold,
          createdAt: a.createdAt,
        })),
      })
    );
  } catch (err) {
    console.error("[api/risk/alerts]", err);
    return NextResponse.json(
      { error: "Không tải được cảnh báo rủi ro." },
      { status: 500 }
    );
  }
}
