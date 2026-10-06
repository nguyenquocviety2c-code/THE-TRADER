import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { updateAgentHealth } from "@/lib/health";
import { callLlmWithRetry, estimateTokens, llmCostUsd } from "@/lib/llm";
import { reapStaleAgentRuns } from "@/lib/agent-ratelimit";
import { expireDueSignals } from "@/lib/signal-execution";
import {
  ROLE_PROMPTS,
  buildMarketBlock,
  buildNewsBlock,
  buildFlowsBlock,
  buildOpenSignalsBlock,
  buildValuationBlock,
  buildLiquidityBlock,
} from "@/lib/agent-context";
import { AGENT_ROSTER } from "@/lib/agent-roster";
import { runServiceAgent, type ServiceRunResult } from "@/lib/agent-service-runs";

export const dynamic = "force-dynamic";
// 300s: 6 LLM tuần tự × timeout 45s (llm.ts) + 17 service ~0.5s + biên độ —
// trước đây 120s dễ bị kill giữa chu kỳ nếu gateway LLM đình trệ (AUD-CODE #8)
export const maxDuration = 300;

/**
 * POST /api/agents/run — chu kỳ phân tích đầy đủ 23 AGENTS (mở rộng Gen-1 §4.1):
 *
 *  ĐỢT A · Nền tảng dữ liệu (4 service, song song — 0 LLM):
 *    data-collector · notification-officer · feature-store · data-integrity
 *  ĐỢT B · Hội đồng Nghiên cứu + Phòng Học máy:
 *    service song song (8): ml-forecast · backtest · learning-rag · rl-gym ·
 *    rl-policy · dl-trainer · rl-trainer · model-registry
 *    LLM tuần tự (4): market-analyst · fair-value · news-sentiment · liquidity
 *  ĐỢT C · Ủy ban Kiểm soát (VETO): risk-manager (LLM) + exposure · compliance
 *    (service, chạy song song với risk-manager)
 *  ĐỢT D · Chủ tịch Hội đồng: portfolio-strategist (LLM) tổng hợp TOÀN BỘ
 *    báo cáo 20 agents ở trên → MỘT tín hiệu
 *  ĐỢT E · Thực thi & hậu cần: execution-manager (ghi nhận tín hiệu, KHÔNG tự
 *    tạo lệnh — chờ trader phê duyệt §4.5/§4.9) + settlement · cash-management
 *
 *  LLM provider: src/lib/llm.ts — Opencode Zen space-bunny-free khi có key
 *  (chạy được ngoài sandbox, free-tier $0), GLM-4.6 khi trong sandbox.
 *  Service agents deterministic từ DB — không tốn tokens.
 */

/** F-203 (audit 19-b): rate-limit chu kỳ — chống spam chi phí LLM không giới hạn. */
const CYCLE_COOLDOWN_MS = 60_000;
let lastCycleStartedAt = 0;

// ── Sơ đồ đợt (tất cả code đều nằm trong AGENT_ROSTER 23 agents) ──
const WAVE_A_CODES = ["data-collector", "notification-officer", "feature-store", "data-integrity"] as const;
const WAVE_B_SERVICE_CODES = [
  "ml-forecast", "backtest", "learning-rag", "rl-gym",
  "rl-policy", "dl-trainer", "rl-trainer", "model-registry",
] as const;
const WAVE_B_LLM_CODES = ["market-analyst", "fair-value", "news-sentiment", "liquidity"] as const;
const WAVE_C_LLM_CODES = ["risk-manager"] as const;
const WAVE_C_SERVICE_CODES = ["exposure", "compliance"] as const;
const CHAIRMAN_CODE = "portfolio-strategist";
const WAVE_E_SERVICE_CODES = ["settlement", "cash-management"] as const;
const EXECUTOR_CODE = "execution-manager";
const ALL_CODES = AGENT_ROSTER.map((a) => a.code);

function round100(v: number): number {
  return Math.max(0, Math.round(v / 100) * 100);
}

/** Robustly extract the first JSON object from an LLM response. */
function parseJsonBlock<T extends Record<string, unknown>>(raw: string): Partial<T> | null {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const brace = candidate.match(/\{[\s\S]*\}/);
  if (!brace) return null;
  try {
    return JSON.parse(brace[0]) as Partial<T>;
  } catch {
    return null;
  }
}

interface AgentAnalysis {
  content: string;
  reasoning: string;
  sentiment: "bullish" | "bearish" | "neutral" | null;
}

interface StrategistSignal {
  symbol: string;
  direction: "BUY" | "SELL" | "HOLD";
  confidence: "LOW" | "MEDIUM" | "HIGH";
  score: number;
  rationale: string;
  targetPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

interface StrategistResult {
  summary: string;
  recommendation: string;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  signal: StrategistSignal | null;
}

/** Persist an agent run + restore agent status + update health. */
async function persistRun(
  agentId: string,
  success: boolean,
  startedAt: number,
  tokensIn: number,
  tokensOut: number,
  output: string | null,
  error: string | null
): Promise<{ id: string; durationMs: number }> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt;
  const run = await db.agentRun.create({
    data: {
      agentId,
      taskStatus: success ? "COMPLETED" : "FAILED",
      startedAt: new Date(startedAt),
      finishedAt,
      durationMs,
      tokensIn,
      tokensOut,
      costUsd: llmCostUsd(tokensIn, tokensOut), // space-bunny-free = $0; GLM-4.6 sandbox tính thật
      output,
      error,
    },
  });
  await db.agent.update({
    where: { id: agentId },
    data: { status: success ? "IDLE" : "ERROR", lastRunAt: finishedAt },
  });
  await updateAgentHealth(agentId, success, durationMs, run.id); // F-113: loại run vừa tạo khỏi P50
  return { id: run.id, durationMs };
}

async function persistMessage(
  agentId: string,
  content: string,
  reasoning: string | null,
  sentiment: string | null
) {
  return db.agentMessage.create({
    data: {
      fromAgentId: agentId,
      broadcast: true,
      direction: "AGENT", // PHASE3_BLUEPRINT §4.1 — tin chu kỳ luôn do agent phát
      content,
      reasoning: reasoning || null,
      sentiment: sentiment ?? null,
    },
  });
}

export async function POST() {
  // F-203 (audit 19-b): guard 60s giữa 2 chu kỳ — trả 429 kèm thời gian chờ còn lại
  const now = Date.now();
  const sinceLast = now - lastCycleStartedAt;
  if (sinceLast < CYCLE_COOLDOWN_MS) {
    return NextResponse.json(
      {
        error: `Chu kỳ agent trước đó chạy cách đây ${Math.floor(sinceLast / 1000)}s. Vui lòng đợi thêm chút để tránh tốn chi phí LLM.`,
        retryAfterSeconds: Math.ceil((CYCLE_COOLDOWN_MS - sinceLast) / 1000),
      },
      // F-210b (audit 19-b): header chuẩn Retry-After để client backoff đúng
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((CYCLE_COOLDOWN_MS - sinceLast) / 1000)),
        },
      }
    );
  }

  const cycleStart = Date.now();

  // AUD-CODE #5 + #3: watchdog dọn run/agent kẹt RUNNING (> 5 phút) TRƯỚC khi
  // load — agent kẹt do crash cũ không được phép chặn chu kỳ vĩnh viễn
  await reapStaleAgentRuns();

  // ── Load toàn bộ 23 agents ───────────────────────────────────────
  const agents = await db.agent.findMany({
    where: { code: { in: ALL_CODES } },
    select: { id: true, code: true, config: true, healthScore: true, status: true },
  });
  const byCode = new Map(agents.map((a) => [a.code, a]));
  const missing = ALL_CODES.filter((c) => !byCode.get(c));
  if (missing.length > 0) {
    // AUD-CODE #10: KHÔNG set cooldown khi fail sớm ở bước validate —
    // user không phải chờ 60s vô ích vì lỗi cấu hình (thiếu agent)
    return NextResponse.json(
      {
        error: `Thiếu agent trong hệ thống: ${missing.join(", ")}. Chạy "bun prisma/expand-agents.ts" để đồng bộ roster 23 agents.`,
      },
      { status: 404 }
    );
  }

  // AUD-CODE #3: guard chồng lấn — chu kỳ không đè lên single-run đang chạy
  // (status đã load SAU khi watchdog dọn nên không có giả âm/ giả dương)
  const runningAgents = agents.filter((a) => a.status === "RUNNING");
  if (runningAgents.length > 0) {
    return NextResponse.json(
      {
        error: `Có ${runningAgents.length} agent đang chạy lẻ (${runningAgents
          .map((a) => a.code)
          .slice(0, 3)
          .join(", ")}…). Chờ hoàn tất hoặc thử lại sau — tránh chạy chồng lẫn tốn 2× chi phí LLM.`,
        retryAfterSeconds: 60,
      },
      { status: 409, headers: { "Retry-After": "60" } }
    );
  }

  // AUD-CODE #1 (P1): sweep tín hiệu hết hạn trước mỗi chu kỳ — prompt Chủ tịch
  // và notification-officer chỉ thấy tín hiệu còn hạn
  await expireDueSignals();

  // AUD-CODE #10: cooldown chỉ tính từ lúc chu kỳ THẬT SỰ bắt đầu (qua validate)
  lastCycleStartedAt = now;

  // Mark every agent RUNNING while the cycle executes
  await db.agent.updateMany({
    where: { id: { in: agents.map((a) => a.id) } },
    data: { status: "RUNNING" },
  });

  // Kết quả phân tích theo code (đưa vào digest cho Chủ tịch)
  const analyses = new Map<string, AgentAnalysis>();
  const createdMessages: {
    id: string;
    fromAgentId: string;
    content: string;
    reasoning: string | null;
    sentiment: string | null;
  }[] = [];
  const failures: string[] = [];

  /** Chạy + persist MỘT service agent (deterministic) — trả về result để đọc verdict VETO. */
  async function runOneServiceAgent(code: string): Promise<ServiceRunResult | null> {
    const agent = byCode.get(code)!;
    const startedAt = Date.now();
    try {
      const result: ServiceRunResult = await runServiceAgent(code);
      await persistRun(
        agent.id,
        true,
        startedAt,
        0,
        0,
        JSON.stringify(result.output),
        null
      );
      const message = await persistMessage(agent.id, result.content, result.reasoning, result.sentiment);
      createdMessages.push({
        id: message.id,
        fromAgentId: agent.id,
        content: result.content,
        reasoning: result.reasoning || null,
        sentiment: result.sentiment,
      });
      analyses.set(code, {
        content: result.content,
        reasoning: result.reasoning,
        sentiment: result.sentiment,
      });
      return result;
    } catch (err) {
      failures.push(code);
      console.error(`[api/agents/run] service agent ${code} failed:`, err);
      await persistRun(
        agent.id,
        false,
        startedAt,
        0,
        0,
        null,
        err instanceof Error ? err.message : "Lỗi dịch vụ."
      ).catch(() => undefined);
      return null;
    }
  }

  try {
    // ── 1. Snapshot — builder dùng chung (PHASE3_BLUEPRINT §4.6) ────
    const [market, newsBlock, flowsBlock, openSignalsBlock, valuationBlock, liquidityBlock] =
      await Promise.all([
        buildMarketBlock(),
        buildNewsBlock(),
        buildFlowsBlock(),
        buildOpenSignalsBlock(),
        buildValuationBlock(),
        buildLiquidityBlock(),
      ]);
    const marketBlock = market.block;

    // ── 2. Role prompts cho các agent LLM ──────────────────────────
    const prompts: Record<string, { system: string; user: string }> = {
      "market-analyst": {
        system: ROLE_PROMPTS["market-analyst"].system,
        user: [marketBlock, flowsBlock].join("\n\n"),
      },
      "fair-value": {
        system: ROLE_PROMPTS["fair-value"].system,
        user: [marketBlock, valuationBlock].join("\n\n"),
      },
      "news-sentiment": {
        system: ROLE_PROMPTS["news-sentiment"].system,
        user: [marketBlock, newsBlock, flowsBlock].join("\n\n"),
      },
      liquidity: {
        system: ROLE_PROMPTS["liquidity"].system,
        user: [marketBlock, liquidityBlock].join("\n\n"),
      },
      "risk-manager": {
        system: ROLE_PROMPTS["risk-manager"].system,
        user: [marketBlock, flowsBlock].join("\n\n"),
      },
    };

    // ══ ĐỢT A · Nền tảng dữ liệu (4 service, song song) ════════════
    await Promise.all(WAVE_A_CODES.map((code) => runOneServiceAgent(code)));

    // ══ ĐỢT B · Nghiên cứu + Học máy ═══════════════════════════════
    // Service agents (8) song song trước — nhanh, 0 LLM
    await Promise.all(WAVE_B_SERVICE_CODES.map((code) => runOneServiceAgent(code)));

    // LLM research agents (4) tuần tự — tôn trọng rate-limit gateway
    for (const code of WAVE_B_LLM_CODES) {
      const agent = byCode.get(code)!;
      const startedAt = Date.now();
      try {
        const { raw, tokensIn, tokensOut } = await callLlmWithRetry(
          prompts[code].system,
          prompts[code].user
        );
        const parsed = parseJsonBlock<{
          content: unknown;
          reasoning: unknown;
          sentiment: unknown;
        }>(raw);
        const content =
          typeof parsed?.content === "string" && parsed.content.trim()
            ? parsed.content.trim()
            : raw.trim();
        const reasoning =
          typeof parsed?.reasoning === "string" ? parsed.reasoning.trim() : "";
        const sentimentRaw =
          typeof parsed?.sentiment === "string" ? parsed.sentiment.toLowerCase() : "";
        const sentiment: AgentAnalysis["sentiment"] =
          sentimentRaw === "bullish" || sentimentRaw === "bearish" || sentimentRaw === "neutral"
            ? (sentimentRaw as AgentAnalysis["sentiment"])
            : null;

        await persistRun(
          agent.id,
          true,
          startedAt,
          tokensIn,
          tokensOut,
          JSON.stringify({ content, reasoning, sentiment }),
          null
        );
        const message = await persistMessage(agent.id, content, reasoning, sentiment);
        createdMessages.push({
          id: message.id,
          fromAgentId: agent.id,
          content,
          reasoning: reasoning || null,
          sentiment,
        });
        analyses.set(code, { content, reasoning, sentiment });
      } catch (err) {
        failures.push(code);
        console.error(`[api/agents/run] agent ${code} failed:`, err);
        await persistRun(
          agent.id,
          false,
          startedAt,
          estimateTokens(prompts[code].system + prompts[code].user),
          0,
          null,
          err instanceof Error ? err.message : "Lỗi không xác định."
        ).catch(() => undefined);
      }
    }

    // Cả 4 agent nghiên cứu LLM đều lỗi → không thể tổng hợp
    if (WAVE_B_LLM_CODES.every((c) => failures.includes(c))) {
      // F-205 (audit 19-b): không để các agent sau kẹt RUNNING khi chu kỳ bỏ cuộc sớm
      await db.agent
        .updateMany({
          where: { code: { in: ALL_CODES.filter((c) => !failures.includes(c) && !analyses.has(c)) } },
          data: { status: "IDLE" },
        })
        .catch(() => undefined);
      return NextResponse.json(
        {
          error:
            "Cả 4 agent nghiên cứu (Market/Fair Value/News/Liquidity) đều lỗi lúc này (mô hình AI không phản hồi). Vui lòng thử lại sau ít phút.",
          failures,
        },
        { status: 502 }
      );
    }

    // ══ ĐỢT C · Ủy ban Kiểm soát (VETO) — risk LLM + 2 service ═════
    const controlResults = await Promise.all([
      (async () => {
        const code = "risk-manager";
        const agent = byCode.get(code)!;
        const startedAt = Date.now();
        try {
          const { raw, tokensIn, tokensOut } = await callLlmWithRetry(
            prompts[code].system,
            prompts[code].user
          );
          const parsed = parseJsonBlock<{ content: unknown; reasoning: unknown }>(raw);
          const content =
            typeof parsed?.content === "string" && parsed.content.trim()
              ? parsed.content.trim()
              : raw.trim();
          const reasoning =
            typeof parsed?.reasoning === "string" ? parsed.reasoning.trim() : "";
          await persistRun(
            agent.id,
            true,
            startedAt,
            tokensIn,
            tokensOut,
            JSON.stringify({ content, reasoning }),
            null
          );
          const message = await persistMessage(agent.id, content, reasoning, null);
          createdMessages.push({
            id: message.id,
            fromAgentId: agent.id,
            content,
            reasoning: reasoning || null,
            sentiment: null,
          });
          analyses.set(code, { content, reasoning, sentiment: null });
        } catch (err) {
          failures.push(code);
          console.error(`[api/agents/run] agent ${code} failed:`, err);
          await persistRun(
            agent.id,
            false,
            startedAt,
            estimateTokens(prompts[code].system + prompts[code].user),
            0,
            null,
            err instanceof Error ? err.message : "Lỗi không xác định."
          ).catch(() => undefined);
        }
      })(),
      ...WAVE_C_SERVICE_CODES.map((code) => runOneServiceAgent(code)),
    ]);

    // ══ AUD-CODE #6: ENFORCE VETO — Ủy ban Kiểm soát có quyền phủ quyết THẠT ══
    // Trước đây verdict "VETO" của exposure/compliance chỉ là text trong digest —
    // Chủ tịch (LLM) có thể bỏ qua. Giờ ràng buộc cứng đúng kiến trúc Gen-1 §4.1:
    //  - exposure VETO (danh mục vượt hạn mức) → chặn tín hiệu MUA (tăng phơi nhiễm);
    //  - compliance VETO (biên margin âm / mode chưa cấu hình) → chặn MỌI tín hiệu mới.
    const controlOutputs = WAVE_C_SERVICE_CODES.map(
      (code, i) => ({ code, result: controlResults[i + 1] }) // index 0 = risk-manager
    );
    const vetoExposure = controlOutputs.some(
      (c) =>
        c.code === "exposure" &&
        typeof c.result?.output?.verdict === "string" &&
        (c.result.output.verdict as string).startsWith("VETO")
    );
    const vetoCompliance = controlOutputs.some(
      (c) =>
        c.code === "compliance" &&
        typeof c.result?.output?.verdict === "string" &&
        (c.result.output.verdict as string).startsWith("VETO")
    );
    const vetoBlocked = vetoExposure || vetoCompliance;

    // ══ ĐỢT D · Chủ tịch Hội đồng — tổng hợp 20 agents ═════════════
    const digestLines = AGENT_ROSTER.filter((a) => analyses.has(a.code)).map((a) => {
      const an = analyses.get(a.code)!;
      const truncated =
        an.content.length > 160 ? `${an.content.slice(0, 160).trimEnd()}…` : an.content;
      return `- ${a.name} (${a.gen1}): ${truncated}`;
    });
    const strategistAgent = byCode.get(CHAIRMAN_CODE)!;
    const vetoNotice = vetoBlocked
      ? [
          "RÀNG BUỘC CỨNG TỪ ỦY BAN KIỂM SOÁT (VETO — bắt buộc tuân thủ):",
          vetoExposure
            ? "- Exposure A7 đã VETO: danh mục vượt hạn mức ngành/vị thế — KHÔNG được đưa tín hiệu MUA mới; chỉ được GIỮ hoặc BÁN để cắt tỷ trọng."
            : "",
          vetoCompliance
            ? "- Compliance A8 đã VETO: biên margin/chế độ giao dịch hiện không đạt — KHÔNG được đưa bất kỳ tín hiệu mới nào (direction phải là HOLD)."
            : "",
          "Hệ thống sẽ tự động hạ tầm tín hiệu vi phạm về HOLD — hãy phân tích theo giới hạn này.",
        ].filter(Boolean)
      : [];

    const strategistUserPrompt = [
      [marketBlock, newsBlock, flowsBlock, valuationBlock, liquidityBlock].join("\n\n"),
      `TÍN HIỆU ĐANG MỞ:\n${openSignalsBlock}`,
      "",
      `BÁO CÁO TỪ ${digestLines.length} AGENTS CỦA HỘI ĐỒNG (để tổng hợp):`,
      ...digestLines,
      ...(vetoNotice.length > 0 ? ["", ...vetoNotice] : []),
      "",
      "Hãy tổng hợp toàn bộ và đưa ra MỘT tín hiệu theo đúng định dạng JSON đã yêu cầu.",
    ].join("\n");

    const strategistStart = Date.now();
    let strategist: StrategistResult | null = null;
    let strategistRunId = "";
    try {
      const { raw, tokensIn, tokensOut } = await callLlmWithRetry(
        ROLE_PROMPTS[CHAIRMAN_CODE].system,
        strategistUserPrompt
      );
      const parsed = parseJsonBlock<{
        summary: unknown;
        recommendation: unknown;
        confidence: unknown;
        signal: unknown;
      }>(raw);
      const summary =
        typeof parsed?.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : raw.trim();
      const recommendation =
        typeof parsed?.recommendation === "string" ? parsed.recommendation.trim() : "";
      const confidenceRaw =
        typeof parsed?.confidence === "string" ? parsed.confidence.toUpperCase() : "MEDIUM";
      const confidence: StrategistResult["confidence"] =
        confidenceRaw === "HIGH" || confidenceRaw === "LOW" ? confidenceRaw : "MEDIUM";

      let signal: StrategistSignal | null = null;
      const s = parsed?.signal as Partial<StrategistSignal> | null | undefined;
      if (s && typeof s.symbol === "string" && typeof s.direction === "string") {
        const direction =
          s.direction === "BUY" || s.direction === "SELL" || s.direction === "HOLD"
            ? s.direction
            : "HOLD";
        const score = Math.max(0, Math.min(100, Number(s.score ?? 50) || 0));
        const conf: StrategistSignal["confidence"] =
          typeof s.confidence === "string" &&
          ["LOW", "MEDIUM", "HIGH"].includes(s.confidence)
            ? (s.confidence as StrategistSignal["confidence"])
            : confidence;
        signal = {
          symbol: s.symbol.trim().toUpperCase(),
          direction,
          confidence: conf,
          score,
          rationale:
            typeof s.rationale === "string" && s.rationale.trim()
              ? s.rationale.trim()
              : recommendation || summary,
          targetPrice:
            s.targetPrice != null && Number.isFinite(Number(s.targetPrice))
              ? round100(Number(s.targetPrice))
              : null,
          stopLoss:
            s.stopLoss != null && Number.isFinite(Number(s.stopLoss))
              ? round100(Number(s.stopLoss))
              : null,
          takeProfit:
            s.takeProfit != null && Number.isFinite(Number(s.takeProfit))
              ? round100(Number(s.takeProfit))
              : null,
        };
      }

      strategist = { summary, recommendation, confidence, signal };

      const run = await persistRun(
        strategistAgent.id,
        true,
        strategistStart,
        tokensIn,
        tokensOut,
        JSON.stringify({ summary, recommendation, confidence, signal }),
        null
      );
      strategistRunId = run.id;
      const message = await persistMessage(
        strategistAgent.id,
        summary,
        recommendation || null,
        confidence === "HIGH" ? "bullish" : confidence === "LOW" ? "neutral" : "neutral"
      );
      createdMessages.push({
        id: message.id,
        fromAgentId: strategistAgent.id,
        content: summary,
        reasoning: recommendation || null,
        sentiment: confidence === "HIGH" ? "bullish" : "neutral",
      });
    } catch (strategistErr) {
      console.error("[api/agents/run] strategist failed:", strategistErr);
      failures.push(CHAIRMAN_CODE);
      await persistRun(
        strategistAgent.id,
        false,
        strategistStart,
        estimateTokens(ROLE_PROMPTS[CHAIRMAN_CODE].system + strategistUserPrompt),
        0,
        null,
        strategistErr instanceof Error ? strategistErr.message : "Lỗi tổng hợp."
      ).catch(() => undefined);
    }

    // ══ ĐỢT E · Thực thi & hậu cần ═════════════════════════════════
    // Execution Manager — ghi nhận tín hiệu, chờ phê duyệt (PHASE3_BLUEPRINT
    // §4.5/§4.9): chu kỳ KHÔNG tự tạo Order — tín hiệu BUY/SELL giữ status
    // ACTIVE, trader phê duyệt/từ chối qua POST /api/signals/[id]/decision.
    const executorAgent = byCode.get(EXECUTOR_CODE)!;
    let createdSignal: {
      id: string;
      symbol: string;
      direction: string;
      score: number;
      confidence: string;
    } | null = null;
    let executionRunId = "";
    let signalExpiresAt: Date | null = null;

    const validInstrumentId = strategist?.signal
      ? market.instrumentIdBySymbol.get(strategist.signal.symbol)
      : undefined;

    if (strategist?.signal && validInstrumentId) {
      const sig = strategist.signal;
      // AUD-CODE #6: VETO hard-enforce — tín hiệu vi phạm bị hạ tầm về HOLD
      // (exposure chặn MUA / compliance chặn mọi hướng mới) kèm lý do gián tiếp
      let vetoedBy: string | null = null;
      if (vetoBlocked && sig.direction !== "HOLD") {
        vetoedBy = vetoCompliance
          ? "Compliance A8 VETO — biên margin/chế độ giao dịch hiện không đạt"
          : "Exposure A7 VETO — danh mục vượt hạn mức phơi nhiễm, chỉ chấp nhận SELL hoặc HOLD";
        if (!vetoCompliance && sig.direction === "SELL") {
          // Exposure chỉ chặn MUA (SELL giảm phơi nhiễm → được phép)
        } else {
          sig.rationale = `[BỊ ỦY BAN KIỂM SOÁT PHỦ QUYẾT → hạ về GIỮ] ${vetoedBy}. Đề xuất gốc bị chặn. ${sig.rationale}`;
          sig.direction = "HOLD";
          sig.targetPrice = null;
          sig.stopLoss = null;
          sig.takeProfit = null;
        }
      }
      const expiresAt = new Date(Date.now() + 3 * 86_400_000);
      signalExpiresAt = expiresAt;

      const signalRow = await db.signal.create({
        data: {
          instrumentId: validInstrumentId,
          direction: sig.direction,
          confidence: sig.confidence,
          score: sig.score,
          rationale: sig.rationale,
          agentId: strategistAgent.id,
          targetPrice: sig.direction === "HOLD" ? null : sig.targetPrice,
          stopLoss: sig.direction === "BUY" ? sig.stopLoss : null,
          takeProfit: sig.direction === "BUY" ? sig.takeProfit : null,
          expiresAt,
          status: "ACTIVE", // chờ phê duyệt của trader (mặc định schema)
        },
      });
      createdSignal = {
        id: signalRow.id,
        symbol: sig.symbol,
        direction: sig.direction,
        score: sig.score,
        confidence: sig.confidence,
      };
      // Audit đổi từ SIGNAL_APPROVED → SIGNAL_CREATED (§4.5: phê duyệt là việc của trader)
      await db.auditLog.create({
        data: {
          action: "SIGNAL_CREATED",
          entity: "Signal",
          entityId: signalRow.id,
          after: JSON.stringify({
            symbol: sig.symbol,
            direction: sig.direction,
            score: sig.score,
          }),
        },
      });

      // Nội dung execution manager: ghi nhận tín hiệu — KHÔNG tự đặt lệnh
      let executionContent: string;
      let executionReasoning: string;
      let execOutput: Record<string, unknown>;
      if (sig.direction !== "HOLD") {
        executionContent = `Nhận tín hiệu ${sig.direction === "BUY" ? "MUA" : "BÁN"} ${sig.symbol} (điểm ${sig.score}/100, tin cậy ${sig.confidence}) từ Chủ tịch Hội đồng sau khi hội đủ báo cáo của ${digestLines.length} agents. Đã ghi nhận tín hiệu — chờ phê duyệt của trader (nút Phê duyệt/từ chối ở luồng tin nhắn hoặc tab Tín hiệu).`;
        executionReasoning =
          "Tín hiệu ghi nhận ở trạng thái ACTIVE — chờ trader phê duyệt trước khi tạo lệnh.";
        execOutput = { signalId: signalRow.id, awaitingApproval: true };
      } else {
        executionContent = vetoedBy
          ? `Tín hiệu ${sig.symbol} bị Ủy ban Kiểm soát PHỦ QUYẾT (${vetoedBy}) — hạ về GIỮ, không trình lệnh mới. Điểm ${sig.score}/100.`
          : `Nhận tín hiệu GIỮ ${sig.symbol} (điểm ${sig.score}/100). Không tạo lệnh mới (tín hiệu GIỮ).`;
        executionReasoning = vetoedBy
          ? "VETO hard-enforce (AUD-CODE #6): tín hiệu vi phạm bị hạ về HOLD."
          : "Tín hiệu GIỮ — không tạo lệnh.";
        execOutput = { signalId: signalRow.id, direction: "HOLD", vetoed: Boolean(vetoedBy) };
      }

      const execStart = Date.now();
      const execRun = await persistRun(
        executorAgent.id,
        true,
        execStart,
        0,
        0,
        JSON.stringify(execOutput),
        null
      );
      executionRunId = execRun.id;
      const execMessage = await persistMessage(
        executorAgent.id,
        executionContent,
        executionReasoning,
        null
      );
      createdMessages.push({
        id: execMessage.id,
        fromAgentId: executorAgent.id,
        content: executionContent,
        reasoning: executionReasoning,
        sentiment: null,
      });
    } else {
      // No valid signal — record a no-op execution run
      // AUD-CODE #13: nói rõ vì sao (Chủ tịch không ra tín hiệu / mã hallucinate)
      const execStart = Date.now();
      const noSignalReason = strategist?.signal
        ? `invalid-symbol:${strategist.signal.symbol}`
        : "no-signal";
      const execRun = await persistRun(
        executorAgent.id,
        true,
        execStart,
        0,
        0,
        JSON.stringify({ action: "noop", reason: noSignalReason }),
        null
      );
      executionRunId = execRun.id;
      if (strategist?.signal && !validInstrumentId) {
        // Chairman hallucinate mã ngoài bảng giá — ghi rõ để trader biết
        const warnMessage = await persistMessage(
          executorAgent.id,
          `Chủ tịch Hội đồng đề xuất mã ${strategist.signal.symbol} không có trong bảng instrument — tín hiệu bị bỏ qua (no fabrication). Đề nghị Chủ tịch chỉ chọn mã trong danh mục VN30 đang theo dõi.`,
          "Mã không hợp lệ — từ chối ghi nhận tín hiệu.",
          null
        );
        createdMessages.push({
          id: warnMessage.id,
          fromAgentId: executorAgent.id,
          content: warnMessage.content,
          reasoning: warnMessage.reasoning,
          sentiment: null,
        });
      }
    }

    // Settlement + Cash Management (service, song song)
    await Promise.all(WAVE_E_SERVICE_CODES.map((code) => runOneServiceAgent(code)));

    // ── Cycle-level audit log ──────────────────────────────────────
    const cycleDurationMs = Date.now() - cycleStart;
    const ranCount = analyses.size + (strategist ? 1 : 0) + (executionRunId ? 1 : 0);
    await db.auditLog.create({
      data: {
        action: "AGENT_RUN_COMPLETED",
        entity: "AgentRun",
        entityId: strategistRunId || executionRunId || null,
        after: JSON.stringify({
          architecture: "23-agents",
          messages: createdMessages.length,
          agentsRan: ranCount,
          signal: createdSignal?.symbol ?? null,
          order: null, // §4.9 — chu kỳ không còn tự tạo lệnh
          durationMs: cycleDurationMs,
          failures,
        }),
      },
    });

    // ── Response (shape per TECHNICAL_BLUEPRINT §4) ────────────────
    const messageRows = await db.agentMessage.findMany({
      where: { id: { in: createdMessages.map((m) => m.id) } },
      include: { fromAgent: { select: { code: true, name: true, role: true } } },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json(
      toPlain({
        runId: strategistRunId || executionRunId || null,
        messages: messageRows,
        signals: createdSignal
          ? [
              {
                ...createdSignal,
                rationale: strategist?.signal?.rationale ?? "",
                targetPrice: strategist?.signal?.targetPrice ?? null,
                stopLoss: strategist?.signal?.stopLoss ?? null,
                takeProfit: strategist?.signal?.takeProfit ?? null,
                expiresAt: signalExpiresAt,
              },
            ]
          : [],
        order: null, // giữ trường cho client cũ — lệnh chỉ tạo khi trader phê duyệt
        failures,
        durationMs: cycleDurationMs,
        // Mở rộng 23 agents — tổng kết các đợt đã chạy
        waves: {
          architecture: "23-agents",
          agentsRan: ranCount,
          platform: WAVE_A_CODES.length,
          researchAndMl: WAVE_B_SERVICE_CODES.length + WAVE_B_LLM_CODES.length,
          control: WAVE_C_LLM_CODES.length + WAVE_C_SERVICE_CODES.length,
          // AUD-CODE #11: đếm động theo run thật — không hardcode khi strategist fail
          executive:
            (strategist ? 1 : 0) +
            (executionRunId ? 1 : 0) +
            WAVE_E_SERVICE_CODES.length,
        },
      })
    );
  } catch (err) {
    // Absolute last-resort guard — never crash the app
    console.error("[api/agents/run] unexpected error:", err);
    try {
      await db.agent.updateMany({
        where: { id: { in: agents.map((a) => a.id) } },
        data: { status: "ERROR" },
      });
    } catch {
      // swallow — logging already happened
    }
    return NextResponse.json(
      { error: "Chu kỳ phân tích gặp lỗi không mong muốn. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
