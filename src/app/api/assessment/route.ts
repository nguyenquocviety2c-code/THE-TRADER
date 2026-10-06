import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { loadAssessmentHistory, loadLatestAssessment } from "@/lib/bayes/persist";
import type { AssessmentResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/assessment (phiên #34 — Nhiệm vụ 4) — Bộ tổng hợp Bayes:
 *  - assessment: bản MarketAssessmentView mới nhất (null khi chưa chạy lần nào)
 *  - history: 30 bản gần nhất (createdAt/pUp/pDown/pFlat/marketDirection/confidence)
 * Chưa có assessment nào → 200 với {assessment: null, history: []}.
 */
export async function GET() {
  try {
    const [assessment, history] = await Promise.all([
      loadLatestAssessment(),
      loadAssessmentHistory(30),
    ]);
    const payload: AssessmentResponse = { assessment, history };
    return NextResponse.json(toPlain(payload));
  } catch (err) {
    console.error("[api/assessment] GET failed:", err);
    return NextResponse.json(
      { error: "Không đọc được Bộ tổng hợp Bayes. Vui lòng thử lại sau." },
      { status: 500 }
    );
  }
}
