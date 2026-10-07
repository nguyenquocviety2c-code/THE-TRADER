import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { buildResearchScorecard } from "@/lib/research/scorecard";

export const dynamic = "force-dynamic";

/**
 * GET /api/research/scorecard (B8 — MARKET_EXPANSION_BLUEPRINT §3.6) —
 * bảng điểm Hội đồng Nghiên cứu: 6 cử tri (5 agent LLM + ml-forecast),
 * hit-rate 5 phiên · Brier · đóng góp posterior |Δlog-odds| · streak ·
 * posterior bandit · healthScore. Thuần DB — 0 LLM.
 *
 * Trả đủ 6 dòng kể cả khi chưa có BanditEvent settle nào
 * (hitRate/brier null, enoughData=false — UI tự trung thực "chưa đủ dữ liệu").
 */
export async function GET() {
  try {
    const agents = await buildResearchScorecard();
    return NextResponse.json(
      toPlain({ agents, generatedAt: new Date().toISOString() })
    );
  } catch (err) {
    console.error("[api/research/scorecard] GET failed:", err);
    return NextResponse.json(
      { error: "Không đọc được bảng điểm Hội đồng Nghiên cứu." },
      { status: 500 }
    );
  }
}
