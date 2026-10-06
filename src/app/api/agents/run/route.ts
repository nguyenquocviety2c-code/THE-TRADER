import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { updateAgentHealth } from "@/lib/health";
import {
  callLlmWithRetry,
  estimateTokens,
  llmCostUsd,
} from "@/lib/llm";
import {
  ROLE_PROMPTS,
  buildMarketBlock,
  buildNewsBlock,
  buildFlowsBlock,
  buildOpenSignalsBlock,
} from "@/lib/agent-context";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/agents/run — full multi-agent analysis cycle
 * (TECHNICAL_BLUEPRINT §5.2):
 *
 *  1. Snapshot: quotes, 90-day bars (top liquid), positions, account, risk alerts
 *     — qua các builder src/lib/agent-context.ts (PHASE3_BLUEPRINT §4.6)
 *  2. Role prompts dùng chung ROLE_PROMPTS (single-run & chat cùng nguồn)
 *  3. Run 3 analysis agents in parallel (market / news / risk) → AgentMessage + AgentRun
 *  4. Portfolio Strategist consolidates → AgentMessage + AgentRun + Signal
 *  5. Execution Manager (deterministic) → ghi nhận tín hiệu, KHÔNG tự tạo lệnh —
 *     tín hiệu để status ACTIVE chờ trader phê duyệt (PHASE3_BLUEPRINT §4.5/§4.9)
 *  6. AuditLog: SIGNAL_CREATED · AGENT_RUN_COMPLETED
 */

const ANALYST_CODES = ["market-analyst", "news-sentiment", "risk-manager"] as const;
const STRATEGIST_CODE = "portfolio-strategist";
const EXECUTOR_CODE = "execution-manager";
const ALL_CODES = [...ANALYST_CODES, STRATEGIST_CODE, EXECUTOR_CODE] as const;

/** F-203 (audit 19-b): rate-limit chu kỳ — chống spam chi phí LLM không giới hạn. */
const CYCLE_COOLDOWN_MS = 60_000;
let lastCycleStartedAt = 0;

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
  const costUsd = llmCostUsd(tokensIn, tokensOut);
  const run = await db.agentRun.create({
    data: {
      agentId,
      taskStatus: success ? "COMPLETED" : "FAILED",
      startedAt: new Date(startedAt),
      finishedAt,
      durationMs,
      tokensIn,
      tokensOut,
      costUsd,
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
  lastCycleStartedAt = now;

  const cycleStart = Date.now();

  // ── Load the 5 agents ────────────────────────────────────────────
  const agents = await db.agent.findMany({
    where: { code: { in: [...ALL_CODES] } },
    select: { id: true, code: true, config: true, healthScore: true },
  });
  const byCode = new Map(agents.map((a) => [a.code, a]));
  const missing = ALL_CODES.filter((c) => !byCode.get(c));
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Thiếu agent trong hệ thống: ${missing.join(", ")}.` },
      { status: 404 }
    );
  }

  // Mark every agent RUNNING while the cycle executes
  await db.agent.updateMany({
    where: { id: { in: agents.map((a) => a.id) } },
    data: { status: "RUNNING" },
  });

  try {
    // ── 1. Snapshot — builder dùng chung (PHASE3_BLUEPRINT §4.6) ────
    const [market, newsBlock, flowsBlock, openSignalsBlock] = await Promise.all([
      buildMarketBlock(),
      buildNewsBlock(),
      buildFlowsBlock(),
      buildOpenSignalsBlock(),
    ]);
    const marketBlock = market.block;

    // ── 2. Role prompts (ROLE_PROMPTS — cùng nguồn với single-run/chat) ──
    const prompts: Record<string, { system: string; user: string }> = {
      "market-analyst": {
        system: ROLE_PROMPTS["market-analyst"].system,
        user: [marketBlock, flowsBlock].join("\n\n"),
      },
      "news-sentiment": {
        system: ROLE_PROMPTS["news-sentiment"].system,
        user: [marketBlock, newsBlock, flowsBlock].join("\n\n"),
      },
      "risk-manager": {
        system: ROLE_PROMPTS["risk-manager"].system,
        user: [marketBlock, flowsBlock].join("\n\n"),
      },
      "portfolio-strategist": {
        system: ROLE_PROMPTS["portfolio-strategist"].system,
        user: [marketBlock, newsBlock, flowsBlock, `TÍN HIỆU ĐANG MỞ:\n${openSignalsBlock}`].join(
          "\n\n"
        ),
      },
    };

    // ── 3. Three analysis agents — sequential (SDK rate limits concurrency) ──
    const analyses: Partial<Record<(typeof ANALYST_CODES)[number], AgentAnalysis>> = {};
    const createdMessages: {
      id: string;
      fromAgentId: string;
      content: string;
      reasoning: string | null;
      sentiment: string | null;
    }[] = [];
    const failures: string[] = [];

    for (const code of ANALYST_CODES) {
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

        const run = await persistRun(
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
        analyses[code] = { content, reasoning, sentiment };
        void run;
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

    // All three analysts failed → the cycle cannot be consolidated
    if (failures.length === ANALYST_CODES.length) {
      // F-205 (audit 19-b): không để strategist/executor kẹt RUNNING khi chu kỳ bỏ cuộc sớm
      await db.agent
        .updateMany({
          where: { code: { in: [STRATEGIST_CODE, EXECUTOR_CODE] } },
          data: { status: "IDLE" },
        })
        .catch(() => undefined);
      return NextResponse.json(
        {
          error:
            "Cả 3 agent phân tích đều lỗi lúc này (mô hình AI không phản hồi). Vui lòng thử lại sau ít phút.",
          failures,
        },
        { status: 502 }
      );
    }

    // ── 4. Portfolio Strategist consolidation ─────────────────────
    const strategistAgent = byCode.get(STRATEGIST_CODE)!;
    const strategistUserPrompt = [
      prompts[STRATEGIST_CODE].user,
      "",
      "KẾT QUẢ TỪ 3 AGENT PHÂN TÍCH (để tổng hợp):",
      `- Market Analyst: ${analyses["market-analyst"]?.content ?? "(agent lỗi — bỏ qua)"}`,
      `- News & Sentiment: ${analyses["news-sentiment"]?.content ?? "(agent lỗi — bỏ qua)"}`,
      `- Risk Manager: ${analyses["risk-manager"]?.content ?? "(agent lỗi — bỏ qua)"}`,
      "",
      "Hãy tổng hợp và đưa ra tín hiệu theo đúng định dạng JSON đã yêu cầu.",
    ].join("\n");

    const strategistStart = Date.now();
    let strategist: StrategistResult | null = null;
    let strategistRunId = "";
    try {
      const { raw, tokensIn, tokensOut } = await callLlmWithRetry(
        prompts[STRATEGIST_CODE].system,
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
      failures.push(STRATEGIST_CODE);
      await persistRun(
        strategistAgent.id,
        false,
        strategistStart,
        estimateTokens(prompts[STRATEGIST_CODE].system + strategistUserPrompt),
        0,
        null,
        strategistErr instanceof Error ? strategistErr.message : "Lỗi tổng hợp."
      ).catch(() => undefined);
    }

    // ── 5. Execution Manager — ghi nhận tín hiệu, chờ phê duyệt ────
    // PHASE3_BLUEPRINT §4.5/§4.9: chu kỳ KHÔNG còn tự tạo Order — tín hiệu
    // BUY/SELL để status ACTIVE, trader phê duyệt/từ chối qua
    // POST /api/signals/[id]/decision.
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
        executionContent = `Nhận tín hiệu ${sig.direction === "BUY" ? "MUA" : "BÁN"} ${sig.symbol} (điểm ${sig.score}/100, tin cậy ${sig.confidence}). Đã ghi nhận tín hiệu — chờ phê duyệt của trader (nút Phê duyệt/từ chối ở luồng tin nhắn hoặc tab Tín hiệu).`;
        executionReasoning =
          "Tín hiệu ghi nhận ở trạng thái ACTIVE — chờ trader phê duyệt trước khi tạo lệnh.";
        execOutput = { signalId: signalRow.id, awaitingApproval: true };
      } else {
        executionContent = `Nhận tín hiệu GIỮ ${sig.symbol} (điểm ${sig.score}/100). Không tạo lệnh mới (tín hiệu GIỮ).`;
        executionReasoning = "Tín hiệu GIỮ — không tạo lệnh.";
        execOutput = { signalId: signalRow.id, direction: "HOLD" };
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
      const execStart = Date.now();
      const execRun = await persistRun(
        executorAgent.id,
        true,
        execStart,
        0,
        0,
        JSON.stringify({ action: "noop", reason: "no-valid-signal" }),
        null
      );
      executionRunId = execRun.id;
    }

    // ── 6. Cycle-level audit log ──────────────────────────────────
    const cycleDurationMs = Date.now() - cycleStart;
    await db.auditLog.create({
      data: {
        action: "AGENT_RUN_COMPLETED",
        entity: "AgentRun",
        entityId: strategistRunId || executionRunId || null,
        after: JSON.stringify({
          messages: createdMessages.length,
          signal: createdSignal?.symbol ?? null,
          order: null, // §4.9 — chu kỳ không còn tự tạo lệnh
          durationMs: cycleDurationMs,
          failures,
        }),
      },
    });

    // ── Response (shape per TECHNICAL_BLUEPRINT §4) ───────────────
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
