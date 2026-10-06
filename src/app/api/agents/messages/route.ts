import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/agents/messages — recent 30 agent messages (newest first)
 * with sender identity for the chat-like timeline.
 */
export async function GET() {
  try {
    const messages = await db.agentMessage.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      include: {
        fromAgent: { select: { code: true, name: true, role: true } },
        toAgent: { select: { code: true, name: true } },
      },
    });

    return NextResponse.json(
      toPlain({
        messages: messages.map((m) => ({
          id: m.id,
          fromAgent: m.fromAgent
            ? { code: m.fromAgent.code, name: m.fromAgent.name, role: m.fromAgent.role }
            : null,
          toAgent: m.toAgent ? { code: m.toAgent.code, name: m.toAgent.name } : null,
          broadcast: m.broadcast,
          // PHASE3 B2 §4.1 — AGENT | USER (chat 1-1 lưu fromAgentId = agent sở hữu thread)
          direction: m.direction as "AGENT" | "USER",
          content: m.content,
          reasoning: m.reasoning,
          sentiment: m.sentiment,
          createdAt: m.createdAt,
        })),
      })
    );
  } catch (err) {
    console.error("[api/agents/messages]", err);
    return NextResponse.json(
      { error: "Không tải được luồng tin nhắn agent." },
      { status: 500 }
    );
  }
}
