import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  buildTrainingSet,
  loadTopSeries,
  trainingWindowDigest,
  ML_FEATURE_COUNT,
  ML_HORIZON_DAYS,
  standardize,
  type TrainingWindowMeta,
} from "@/lib/ml/features";
import { MLP } from "@/lib/ml/nn";
import { buildBasket, policyStance, trainQTable } from "@/lib/ml/rl";
import { settlePendingRewards } from "@/lib/ml/bandit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * POST /api/ml/train (phiên #35 — Task 35-ML) — huấn luyện MÔ HÌNH THẬT
 * trên dữ liệu EOD Supabase: MLP backprop+Adam (dl-mlp) + Q-learning tabular
 * 48×3 (rl-q). Trước khi train luôn kết toán bandit (settlePendingRewards —
 * nhanh, 0 LLM). Hai train chạy TUẦN TỰ (không Promise.all — tránh ép CPU
 * đè nhau), mỗi cái gói try/catch để hỏng cái này không chặn cái kia.
 *
 * Versioning: updateMany bản serving cùng kind → archived, create version
 * max+1 (weights = JSON mạng/Q-table, featureNorm = z-score, metrics JSON).
 * Cooldown in-memory 10s → 429 kèm Retry-After (pattern synthesize #34).
 */
const COOLDOWN_MS = 10_000;
let lastTrainAt = 0;

type MlTrainTarget = "all" | "dl-mlp" | "rl-q";

/** Metrics trả về FE — khớp DlMlpMetrics trong src/hooks/use-ml.ts. */
interface TrainedDlMlpMetrics {
  epochs: number;
  samples: number;
  trainAcc: number;
  valAcc: number;
  trainLoss: number;
  valLoss: number;
  horizonDays: number;
  features: number;
  topSymbols: string[];
}

/** Metrics trả về FE — khớp RlQMetrics trong src/hooks/use-ml.ts. */
interface TrainedRlQMetrics {
  episodes: number;
  epsilonEnd: number;
  avgRewardLast50: number;
  states: number;
  actions: number;
  stance: string;
  exposure: number;
  qMax: number;
}

/** Version kế tiếp của một kind (max mọi status + 1). */
async function nextVersion(kind: string): Promise<number> {
  const agg = await db.mlModel.aggregate({ _max: { version: true }, where: { kind } });
  return (agg._max.version ?? 0) + 1;
}

/** Lưu model mới: archive bản serving cũ + create version mới.
 *  P1-2 (#60): meta = JSON TrainingWindowMeta (window-hash SHA-256 + biên
 *  ngày train) — null giữ cho model không có window (gọi trực tiếp). */
async function saveModel(
  kind: string,
  weights: string,
  featureNorm: string | null,
  metrics: Record<string, unknown>,
  meta: TrainingWindowMeta | null = null
): Promise<number> {
  const version = await nextVersion(kind);
  await db.mlModel.updateMany({
    where: { kind, status: "serving" },
    data: { status: "archived" },
  });
  await db.mlModel.create({
    data: {
      kind,
      version,
      status: "serving",
      weights,
      featureNorm,
      metrics: JSON.stringify(metrics),
      ...(meta ? { meta: JSON.stringify(meta) } : {}),
    },
  });
  return version;
}

/**
 * Train MLP 10→16→8→3 trên top-20 thanh khoản: buildTrainingSet → cap 60k
 * mẫu gần nhất → z-score → fit (Adam, early-stop) → topSymbols theo độ tách
 * pUp−pDown của mô hình trên từng mã → lưu MlModel kind dl-mlp.
 */
async function trainDlMlp(): Promise<TrainedDlMlpMetrics> {
  const set = await buildTrainingSet(20);
  if (set.X.length < 600) {
    throw new Error(`chỉ có ${set.X.length} mẫu huấn luyện (cần ≥ 600) — kiểm tra dữ liệu EOD`);
  }
  // P1-2 — digest cửa sổ train TRÊN CHÍNH chuỗi dữ liệu vừa dùng (tái lập PIT)
  const series = await loadTopSeries(20);
  const windowMeta = trainingWindowDigest(series, { samples: set.X.length });
  const { mean, std, Xstd } = standardize(set.X);
  const mlp = new MLP();
  const fit = mlp.fit(Xstd, set.y);
  mlp.setNorm({ mean, std });

  // topSymbols: mã nào dự báo tách bạch nhất (mean |pUp − pDown| trên mẫu của mã)
  const preds = mlp.predictBatch(set.X);
  const bySymbol = new Map<string, { sum: number; n: number }>();
  set.symbols.forEach((sym, i) => {
    const agg = bySymbol.get(sym) ?? { sum: 0, n: 0 };
    agg.sum += Math.abs(preds[i][0] - preds[i][2]);
    agg.n++;
    bySymbol.set(sym, agg);
  });
  const topSymbols = [...bySymbol.entries()]
    .map(([symbol, a]) => ({ symbol, sep: a.sum / a.n }))
    .sort((a, b) => b.sep - a.sep)
    .slice(0, 8)
    .map((r) => r.symbol);

  const metrics: TrainedDlMlpMetrics = {
    epochs: fit.epochs,
    samples: fit.samples,
    trainAcc: fit.trainAcc,
    valAcc: fit.valAcc,
    trainLoss: fit.trainLoss,
    valLoss: fit.valLoss,
    horizonDays: ML_HORIZON_DAYS,
    features: ML_FEATURE_COUNT,
    topSymbols,
  };
  await saveModel("dl-mlp", mlp.toJSON(), JSON.stringify({ mean, std }), { ...metrics }, windowMeta);
  return metrics;
}

/**
 * Train Q-learning 48×3 trên rổ top-10 thanh khoản → lưu MlModel kind rl-q
 * (weights = Q-table JSON; metrics kèm stance/exposure/qMax hiện tại).
 */
async function trainRlQ(): Promise<TrainedRlQMetrics> {
  const series = await loadTopSeries(10);
  const closes = series.map((s) => s.closes);
  if (series.length < 5 || Math.min(...closes.map((c) => c.length)) < 80) {
    throw new Error("rổ top-10 không đủ dữ liệu (≥ 80 phiên/mã) để train Q-learning");
  }
  // P1-2 — digest rổ Q-learning (tái lập PIT — cùng hàm với dl-mlp)
  const windowMeta = trainingWindowDigest(series);
  const q = trainQTable(closes);
  const basket = buildBasket(closes);
  const stance = policyStance(q.qTable, basket, 0.5);
  const metrics: TrainedRlQMetrics = {
    episodes: q.episodes,
    epsilonEnd: q.epsilonEnd,
    avgRewardLast50: q.avgRewardLast50,
    states: q.states,
    actions: q.actions,
    stance: stance.stance,
    exposure: stance.exposure,
    qMax: stance.qMax,
  };
  await saveModel("rl-q", JSON.stringify({ qTable: q.qTable }), null, { ...metrics }, windowMeta);
  return metrics;
}

export async function POST(req: Request) {
  const now = Date.now();
  const sinceLast = now - lastTrainAt;
  if (sinceLast < COOLDOWN_MS) {
    const retryAfterSeconds = Math.ceil((COOLDOWN_MS - sinceLast) / 1000);
    return NextResponse.json(
      {
        error: `Huấn luyện vừa chạy cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi ${retryAfterSeconds}s rồi thử lại.`,
        retryAfterSeconds,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }

  // Body {target} — default "all" (tolerant: body rỗng/JSON hỏng đều dùng "all")
  let target: MlTrainTarget = "all";
  try {
    const body = (await req.json()) as { target?: unknown } | null;
    if (body && typeof body.target === "string") target = body.target as MlTrainTarget;
  } catch {
    // body rỗng — giữ "all"
  }
  if (target !== "all" && target !== "dl-mlp" && target !== "rl-q") {
    return NextResponse.json(
      { error: `target "${target}" không hợp lệ (all | dl-mlp | rl-q).` },
      { status: 400 }
    );
  }

  lastTrainAt = now;
  const started = Date.now();

  try {
    // Luôn kết toán bandit trước train (nhanh, 0 LLM) — best-effort
    try {
      const settled = await settlePendingRewards();
      console.log(
        `[api/ml/train] bandit settle: ${settled.settled} assessment, ${settled.votes} phiếu`
      );
    } catch (settleErr) {
      console.error("[api/ml/train] settlePendingRewards lỗi (bỏ qua, vẫn train):", settleErr);
    }

    const trained: string[] = [];
    const errors: string[] = [];
    let dlMlp: TrainedDlMlpMetrics | null = null;
    let rlQ: TrainedRlQMetrics | null = null;

    if (target === "all" || target === "dl-mlp") {
      try {
        dlMlp = await trainDlMlp();
        trained.push("dl-mlp");
      } catch (err) {
        console.error("[api/ml/train] trainDlMlp failed:", err);
        errors.push(`MLP: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (target === "all" || target === "rl-q") {
      try {
        rlQ = await trainRlQ();
        trained.push("rl-q");
      } catch (err) {
        console.error("[api/ml/train] trainRlQ failed:", err);
        errors.push(`Q-learning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const durationMs = Date.now() - started;

    // Toàn bộ fail → 500 thật (cho phép retry ngay)
    if (trained.length === 0) {
      lastTrainAt = 0;
      return NextResponse.json(
        { ok: false, trained, durationMs, error: errors.join("; ") || "Huấn luyện thất bại." },
        { status: 500 }
      );
    }

    const payload: Record<string, unknown> = { ok: true, trained, durationMs, dlMlp, rlQ };
    if (errors.length > 0) payload.error = errors.join("; "); // 1 cái fail không chặn cái kia
    return NextResponse.json(payload);
  } catch (err) {
    // Cho phép retry ngay khi lỗi ngoài dự kiến (không giữ cooldown vô ích)
    lastTrainAt = 0;
    console.error("[api/ml/train] POST failed:", err);
    return NextResponse.json(
      { ok: false, error: "Huấn luyện thất bại (lỗi dữ liệu đầu vào). Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
