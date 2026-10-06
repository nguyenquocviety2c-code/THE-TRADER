import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { buildEvidenceBundle } from "@/lib/bayes/evidence";
import { synthesizeMarketAssessment } from "@/lib/bayes/synthesis";
import {
  loadAssessmentHistory,
  saveMarketAssessment,
} from "@/lib/bayes/persist";
import type { AssessmentResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/assessment/synthesize (phiên #34 — Nhiệm vụ 4) — tổng hợp lại
 * NGAY Bộ tổng hợp Bayes deterministic (0 LLM, ~1–2s):
 * buildEvidenceBundle() (đọc DB thật) → synthesizeMarketAssessment() (log-odds
 * 3 bậc nhân quả) → saveMarketAssessment(source "manual") → trả assessment
 * mới + history 30 bản. Rate-limit nhẹ: cooldown 10s → 429 kèm Retry-After.
 */
const COOLDOWN_MS = 10_000;
let lastSynthAt = 0;

export async function POST() {
  const now = Date.now();
  const sinceLast = now - lastSynthAt;
  if (sinceLast < COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
    return NextResponse.json(
      {
        error: `Bộ tổng hợp Bayes vừa chạy cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi ${retryAfterSeconds}s rồi thử lại.`,
        retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(retryAfterSeconds) },
      }
    );
  }
  lastSynthAt = now;

  try {
    const bundle = await buildEvidenceBundle();
    const draft = synthesizeMarketAssessment(bundle);
    const assessment = await saveMarketAssessment(bundle, draft, { source: "manual" });
    const history = await loadAssessmentHistory(30);
    const payload: AssessmentResponse = { assessment, history };
    return NextResponse.json(toPlain(payload));
  } catch (err) {
    // Cho phép retry ngay khi lỗi (không giữ cooldown vô ích)
    lastSynthAt = 0;
    console.error("[api/assessment/synthesize] POST failed:", err);
    return NextResponse.json(
      { error: "Tổng hợp Bayes thất bại (lỗi dữ liệu đầu vào). Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
