import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { updateAgentHealth } from "@/lib/health";
import { buildSingleRunPrompt } from "@/lib/agent-context";
import { checkAgentRateLimit } from "@/lib/agent-ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/agents/[id]/run — chạy riêng 1 agent (PHASE3_BLUEPRINT §4.3).
 *
 * Luồng: guard 404/409/400 → rate-limit 60s (DB là nguồn chân lý) →
 * buildSingleRunPrompt(code) → LLM glm-4.6 → parse JSON theo vai →
 * AgentRun + AgentMessage (broadcast) + health + audit AGENT_RUN_COMPLETED
 * (mode "single"). Lỗi LLM → persistRun FAILED + 502 (pattern run route).
 */

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function usageOf(
  completion: unknown
): { tokensIn: number | null; tokensOut: number | null } {
  const usage = (
    completion as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null
  )?.usage;
  return {
    tokensIn: usage?.prompt_tokens ?? null,
    tokensOut: usage?.completion_tokens ?? null,
  };
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

async function callLlm(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  systemPrompt: string,
  userPrompt: string
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  const completion = await zai.chat.completions.create({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const raw: string =
    (completion as { choices?: { message?: { content?: string } }[] })?.choices?.[0]
      ?.message?.content ?? "";
  if (!raw) throw new Error("Phản hồi trống từ mô hình AI.");
  const usage = usageOf(completion);
  return {
    raw,
    tokensIn: usage.tokensIn ?? estimateTokens(systemPrompt + userPrompt),
    tokensOut: usage.tokensOut ?? estimateTokens(raw),
  };
}

/** LLM call with one retry on rate limit (429) — pattern run route. */
async function callLlmWithRetry(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  systemPrompt: string,
  userPrompt: string
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  try {
    return await callLlm(zai, systemPrompt, userPrompt);
  } catch (err) {
    const isRateLimit = err instanceof Error && err.message.includes("429");
    if (!isRateLimit) throw err;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return callLlm(zai, systemPrompt, userPrompt);
  }
}

/** Persist an agent run + restore agent status + update health (persistRun-style). */
async function persistRun(
  agentId: string,
  success: boolean,
  startedAt: number,
  tokensIn: number,
  tokensOut: number,
  output: string | null,
  error: string | null
): Promise<{ id: string; durationMs: number; costUsd: number }> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt;
  const costUsd = Number(((tokensIn * 0.6 + tokensOut * 2.2) / 1_000_000).toFixed(6));
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
  return { id: run.id, durationMs, costUsd };
}

interface ParsedAgentOutput {
  content: string;
  reasoning: string;
  sentiment: "bullish" | "bearish" | "neutral" | null;
}

/** Parse JSON theo vai (giống run route): analyst {content,reasoning,sentiment}; strategist {summary,recommendation,confidence}. */
function parseAgentOutput(code: string, raw: string): ParsedAgentOutput {
  if (code === "portfolio-strategist") {
    const parsed = parseJsonBlock<{
      summary: unknown;
      recommendation: unknown;
      confidence: unknown;
    }>(raw);
    // Parse fail → fallback dùng raw text làm content (như run route)
    const content =
      typeof parsed?.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : raw.trim();
    const reasoning =
      typeof parsed?.recommendation === "string" ? parsed.recommendation.trim() : "";
    const confidenceRaw =
      typeof parsed?.confidence === "string" ? parsed.confidence.toUpperCase() : "MEDIUM";
    const sentiment =
      confidenceRaw === "HIGH" ? "bullish" : confidenceRaw === "LOW" ? "neutral" : "neutral";
    return { content, reasoning, sentiment };
  }
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
  const sentiment: ParsedAgentOutput["sentiment"] =
    sentimentRaw === "bullish" || sentimentRaw === "bearish" || sentimentRaw === "neutral"
      ? (sentimentRaw as ParsedAgentOutput["sentiment"])
      : null;
  return { content, reasoning, sentiment };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Body {} hoặc { note?: string } — chấp nhận body rỗng
    const body = (await req.json().catch(() => ({}))) as { note?: unknown };
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > 500) {
      return NextResponse.json(
        { error: "Ghi chú quá dài (tối đa 500 ký tự)." },
        { status: 400 }
      );
    }

    const agent = await db.agent.findUnique({ where: { id } });
    if (!agent) {
      return NextResponse.json(
        { error: "Không tìm thấy agent." },
        { status: 404 }
      );
    }
    // Execution Manager cần Signal đầu vào — chỉ chạy trong chu kỳ đầy đủ
    if (agent.code === "execution-manager") {
      return NextResponse.json(
        {
          error:
            "Execution Manager chỉ chạy trong chu kỳ orchestrator đầy đủ (vì cần Signal đầu vào).",
        },
        { status: 409 }
      );
    }
    if (agent.status === "RUNNING") {
      return NextResponse.json(
        { error: "Agent đang chạy một tác vụ khác." },
        { status: 400 }
      );
    }

    // Rate-limit 60s — DB là nguồn chân lý (PHASE3_BLUEPRINT §4.3)
    const rate = await checkAgentRateLimit(agent.id);
    if (!rate.ok) {
      return NextResponse.json(
        {
          error: `Agent vừa chạy cách đây ${60 - rate.retryAfterSeconds}s. Vui lòng đợi thêm để tránh tốn chi phí LLM.`,
          retryAfterSeconds: rate.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rate.retryAfterSeconds) },
        }
      );
    }

    // Đánh dấu RUNNING trong lúc chạy lẻ
    await db.agent.update({ where: { id: agent.id }, data: { status: "RUNNING" } });

    const startedAt = Date.now();
    try {
      // Prompt theo vai (block chọn lọc như run route) + ghi chú tuỳ chọn của trader
      const { system, user } = await buildSingleRunPrompt(agent.code);
      const userPrompt = note
        ? `${user}\n\nGHI CHÚ CỦA TRADER:\n${note}`
        : user;

      const zai = await ZAI.create();
      const { raw, tokensIn, tokensOut } = await callLlmWithRetry(zai, system, userPrompt);

      const parsed = parseAgentOutput(agent.code, raw);
      const { content, reasoning, sentiment } = parsed;

      const run = await persistRun(
        agent.id,
        true,
        startedAt,
        tokensIn,
        tokensOut,
        JSON.stringify({ mode: "single", content, reasoning, sentiment }),
        null
      );

      const message = await db.agentMessage.create({
        data: {
          fromAgentId: agent.id,
          broadcast: true, // tin chạy riêng vẫn vào broadcast feed (§4.3)
          direction: "AGENT",
          content,
          reasoning: reasoning || null,
          sentiment: sentiment ?? null,
        },
      });

      // Audit — AGENT_RUN_COMPLETED mode "single" (§4.3)
      await db.auditLog.create({
        data: {
          action: "AGENT_RUN_COMPLETED",
          entity: "Agent",
          entityId: agent.id,
          after: JSON.stringify({
            mode: "single",
            tokensIn,
            tokensOut,
            costUsd: run.costUsd,
            durationMs: run.durationMs,
          }),
        },
      });

      return NextResponse.json(
        toPlain({
          agent: { id: agent.id, code: agent.code, name: agent.name },
          message: {
            id: message.id,
            content: message.content,
            reasoning: message.reasoning,
            sentiment: message.sentiment,
          },
          run: {
            id: run.id,
            tokensIn,
            tokensOut,
            costUsd: run.costUsd,
            durationMs: run.durationMs,
            taskStatus: "COMPLETED",
          },
        })
      );
    } catch (err) {
      // Lỗi LLM giữa chừng → persistRun FAILED + agent ERROR + audit + 502
      console.error("[api/agents/[id]/run] LLM failed:", err);
      const errorMessage =
        err instanceof Error ? err.message : "Agent không phản hồi được.";
      let tokensInEstimate = 0;
      try {
        const { system, user } = await buildSingleRunPrompt(agent.code);
        tokensInEstimate = estimateTokens(system + user);
      } catch {
        tokensInEstimate = 0;
      }
      const run = await persistRun(
        agent.id,
        false,
        startedAt,
        tokensInEstimate,
        0,
        null,
        errorMessage
      ).catch(() => null);
      await db.auditLog
        .create({
          data: {
            action: "AGENT_RUN_COMPLETED",
            entity: "Agent",
            entityId: agent.id,
            after: JSON.stringify({
              mode: "single",
              failed: true,
              tokensIn: tokensInEstimate,
              tokensOut: 0,
              durationMs: run?.durationMs ?? null,
              error: errorMessage,
            }),
          },
        })
        .catch(() => undefined);
      return NextResponse.json(
        { error: "Agent không phản hồi được lúc này. Vui lòng thử lại sau ít phút." },
        { status: 502 }
      );
    }
  } catch (err) {
    // Absolute last-resort guard — never crash the app
    console.error("[api/agents/[id]/run] unexpected error:", err);
    return NextResponse.json(
      { error: "Không chạy được agent này lúc này. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
