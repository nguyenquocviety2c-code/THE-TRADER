import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { updateAgentHealth } from "@/lib/health";
import { ROLE_PROMPTS, buildChatUserPrompt } from "@/lib/agent-context";
import { checkAgentRateLimit } from "@/lib/agent-ratelimit";
import {
  callChatLlmWithRetry,
  estimateTokens,
  llmCostUsd,
  type LlmMessage,
} from "@/lib/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/agents/[id]/chat — chat trực tiếp 1-1 với agent
 * (PHASE3_BLUEPRINT §4.4):
 *  - tin USER lưu NGAY (hiển thị tức thì kể cả khi LLM lỗi);
 *  - context = role-prompt rút gọn + 10 tin gần nhất của thread + block dữ liệu compact;
 *  - trả lời TỰ DO (không parse JSON); AgentRun đo chi phí; audit AGENT_CHAT;
 *  - lỗi SDK → 200 kèm reply null + error VN (không trả 5xx).
 */

const MAX_MESSAGE_LENGTH = 500;
const HISTORY_TAKE = 10;

type ChatMessageParam = LlmMessage;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const agent = await db.agent.findUnique({ where: { id } });
    if (!agent) {
      return NextResponse.json(
        { error: "Không tìm thấy agent." },
        { status: 404 }
      );
    }
    if (agent.code === "execution-manager") {
      return NextResponse.json(
        {
          error:
            "Execution Manager không hỗ trợ chat trực tiếp — agent này chỉ thực thi trong chu kỳ đầy đủ.",
        },
        { status: 400 }
      );
    }

    // Validate body { message: string } — trim, 2–500 ký tự
    const body = (await req.json().catch(() => ({}))) as { message?: unknown };
    const message =
      typeof body.message === "string" ? body.message.trim() : "";
    if (message.length < 2) {
      return NextResponse.json(
        { error: "Tin nhắn trống." },
        { status: 400 }
      );
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json(
        { error: "Tin nhắn quá dài (tối đa 500 ký tự)." },
        { status: 400 }
      );
    }

    // Rate-limit 60s — DB là nguồn chân lý (như single-run §4.3)
    const rate = await checkAgentRateLimit(agent.id);
    if (!rate.ok) {
      return NextResponse.json(
        {
          error: `Agent vừa chạy cách đây ${Math.max(0, 60 - rate.retryAfterSeconds)}s. Vui lòng đợi thêm để tránh tốn chi phí LLM.`,
          retryAfterSeconds: rate.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": String(rate.retryAfterSeconds) },
        }
      );
    }

    // ── Lưu tin USER ngay — hiển thị tức thì kể cả khi LLM lỗi (§4.4) ──
    const userMessage = await db.agentMessage.create({
      data: {
        fromAgentId: agent.id,
        broadcast: false,
        direction: "USER",
        content: message,
      },
    });

    // ── Context: systemCompact + 10 tin gần nhất của thread (loại tin vừa lưu) ──
    const role = ROLE_PROMPTS[agent.code];
    const system = role?.systemCompact ?? ROLE_PROMPTS["market-analyst"].systemCompact;

    const historyRows = await db.agentMessage.findMany({
      where: { fromAgentId: agent.id, broadcast: false, id: { not: userMessage.id } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_TAKE,
      select: { direction: true, content: true },
    });
    const history: ChatMessageParam[] = historyRows
      .reverse() // desc → asc
      .map((m) => ({
        role: m.direction === "USER" ? ("user" as const) : ("assistant" as const),
        content: m.content.slice(0, MAX_MESSAGE_LENGTH),
      }));

    // user content = câu hỏi + [BỐI CẢNH DỮ LIỆU MỚI NHẤT] rút gọn theo vai
    const userPrompt = await buildChatUserPrompt(agent.code, message);

    const messages: ChatMessageParam[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userPrompt },
    ];

    const startedAt = Date.now();
    try {
      const { raw, tokensIn, tokensOut } = await callChatLlmWithRetry(messages);
      const reply = raw; // chat trả lời tự do — KHÔNG parse JSON

      // Lưu tin trả lời của agent
      const replyMessage = await db.agentMessage.create({
        data: {
          fromAgentId: agent.id,
          broadcast: false,
          direction: "AGENT",
          content: reply,
        },
      });

      // AgentRun đo chi phí — KHÔNG đổi agent.status (chat không đặt RUNNING)
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt;
      const costUsd = llmCostUsd(tokensIn, tokensOut);
      const run = await db.agentRun.create({
        data: {
          agentId: agent.id,
          taskStatus: "COMPLETED",
          startedAt: new Date(startedAt),
          finishedAt,
          durationMs,
          tokensIn,
          tokensOut,
          costUsd,
          output: JSON.stringify({ question: message }),
        },
      });
      await db.agent.update({
        where: { id: agent.id },
        data: { lastRunAt: finishedAt },
      });
      await updateAgentHealth(agent.id, true, durationMs, run.id); // F-113

      const threadLength = await db.agentMessage.count({
        where: { fromAgentId: agent.id, broadcast: false },
      });

      await db.auditLog.create({
        data: {
          action: "AGENT_CHAT",
          entity: "Agent",
          entityId: agent.id,
          after: JSON.stringify({ tokensIn, tokensOut, costUsd, threadLength }),
        },
      });

      return NextResponse.json(
        toPlain({
          userMessage: {
            id: userMessage.id,
            direction: "USER",
            content: userMessage.content,
            createdAt: userMessage.createdAt,
          },
          reply: {
            id: replyMessage.id,
            direction: "AGENT",
            content: replyMessage.content,
            createdAt: replyMessage.createdAt,
          },
          run: { tokensIn, tokensOut, costUsd, durationMs },
          threadLength,
        })
      );
    } catch (err) {
      // Lỗi SDK → KHÔNG 5xx: trả 200 kèm reply null (tin user đã lưu)
      console.error("[api/agents/[id]/chat] LLM failed:", err);
      const errorMessage =
        err instanceof Error ? err.message : "Mô hình AI không phản hồi.";
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt;
      const tokensInEstimate = estimateTokens(messages.map((m) => m.content).join("\n"));
      const costUsd = llmCostUsd(tokensInEstimate, 0);

      // AgentRun FAILED — đo chi phí lần thử thất bại
      await db.agentRun
        .create({
          data: {
            agentId: agent.id,
            taskStatus: "FAILED",
            startedAt: new Date(startedAt),
            finishedAt,
            durationMs,
            tokensIn: tokensInEstimate,
            tokensOut: 0,
            costUsd,
            output: JSON.stringify({ question: message }),
            error: errorMessage,
          },
        })
        .catch(() => undefined);
      await db.agent
        .update({ where: { id: agent.id }, data: { lastRunAt: finishedAt } })
        .catch(() => undefined);

      const threadLength = await db.agentMessage.count({
        where: { fromAgentId: agent.id, broadcast: false },
      });

      await db.auditLog
        .create({
          data: {
            action: "AGENT_CHAT",
            entity: "Agent",
            entityId: agent.id,
            after: JSON.stringify({
              tokensIn: tokensInEstimate,
              tokensOut: 0,
              costUsd,
              threadLength,
              error: errorMessage,
            }),
          },
        })
        .catch(() => undefined);

      return NextResponse.json(
        toPlain({
          userMessage: {
            id: userMessage.id,
            direction: "USER",
            content: userMessage.content,
            createdAt: userMessage.createdAt,
          },
          reply: null,
          run: null,
          threadLength,
          error: "Agent tạm thời không phản hồi — vui lòng thử lại.",
        })
      );
    }
  } catch (err) {
    // Absolute last-resort guard — never crash the app
    console.error("[api/agents/[id]/chat] unexpected error:", err);
    return NextResponse.json(
      { error: "Không gửi được tin nhắn lúc này. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
