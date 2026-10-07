import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { banditSnapshot, pendingSettleCount } from "@/lib/ml/bandit";

export const dynamic = "force-dynamic";

/**
 * GET /api/ml/status (phiên #35 — Task 35-ML) — trạng thái 3 mô hình học
 * thật: MLP dl-mlp + Q-learning rl-q (bảng MlModel, bản serving mới nhất)
 * + 5 arm Thompson sampling (BanditArm) + số phiếu chờ kết toán reward.
 * Chưa từng train → dlMlp/rlQ null (FE render empty-state). Deterministic,
 * 0 LLM, ~3-5 truy vấn nhẹ.
 */

type DlMlpMetricsRow = {
  epochs: number;
  samples: number;
  trainAcc: number;
  valAcc: number;
  trainLoss: number;
  valLoss: number;
  horizonDays?: number;
  features?: number;
  topSymbols?: string[];
};

type RlQMetricsRow = {
  episodes: number;
  epsilonEnd: number;
  avgRewardLast50: number;
  states: number;
  actions: number;
  stance?: string;
  exposure: number;
  qMax: number;
};

/** Parse metrics JSON của MlModel — null khi JSON hỏng/thiếu trường số. */
function parseMetrics<T extends Record<string, unknown>>(
  json: string,
  numberFields: string[]
): T | null {
  try {
    const m = JSON.parse(json) as Record<string, unknown>;
    for (const f of numberFields) {
      if (typeof m[f] !== "number" || !Number.isFinite(m[f] as number)) return null;
    }
    return m as T;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const [dlRow, rlRow, bandit, pendingSettles] = await Promise.all([
      db.mlModel.findFirst({
        where: { kind: "dl-mlp", status: "serving" },
        orderBy: { version: "desc" },
      }),
      db.mlModel.findFirst({
        where: { kind: "rl-q", status: "serving" },
        orderBy: { version: "desc" },
      }),
      banditSnapshot(),
      pendingSettleCount(),
    ]);

    const dlMetrics = dlRow
      ? parseMetrics<DlMlpMetricsRow>(dlRow.metrics, [
          "epochs", "samples", "trainAcc", "valAcc", "trainLoss", "valLoss",
        ])
      : null;
    const rlMetrics = rlRow
      ? parseMetrics<RlQMetricsRow>(rlRow.metrics, [
          "episodes", "epsilonEnd", "avgRewardLast50", "states", "actions",
          "exposure", "qMax",
        ])
      : null;

    const payload = {
      dlMlp:
        dlRow && dlMetrics
          ? {
              version: dlRow.version,
              status: dlRow.status,
              trainedAt: dlRow.trainedAt.toISOString(),
              metrics: {
                ...dlMetrics,
                horizonDays: dlMetrics.horizonDays ?? 5,
                features: dlMetrics.features ?? 10,
                topSymbols: Array.isArray(dlMetrics.topSymbols)
                  ? dlMetrics.topSymbols
                  : [],
              },
            }
          : null,
      rlQ:
        rlRow && rlMetrics
          ? {
              version: rlRow.version,
              status: rlRow.status,
              trainedAt: rlRow.trainedAt.toISOString(),
              metrics: {
                ...rlMetrics,
                stance: typeof rlMetrics.stance === "string" ? rlMetrics.stance : "giữ",
              },
            }
          : null,
      bandit: {
        arms: bandit.arms,
        lastSettleAt: bandit.lastSettleAt ? bandit.lastSettleAt.toISOString() : null,
      },
      pendingSettles,
    };
    return NextResponse.json(toPlain(payload));
  } catch (err) {
    console.error("[api/ml/status] GET failed:", err);
    return NextResponse.json(
      { error: "Không đọc được trạng thái mô hình học máy." },
      { status: 500 }
    );
  }
}
