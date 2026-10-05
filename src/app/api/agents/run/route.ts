import { NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AGENT_CODE = "portfolio-strategist";

const SYSTEM_PROMPT = `Bạn là agent "Portfolio Strategist" của hệ thống giao dịch đa tác tử The Trader, hoạt động tại công ty chứng khoán VNDIRECT (Việt Nam).
Nhiệm vụ: tổng hợp dữ liệu thị trường VN30, danh mục hiện tại và cảnh báo rủi ro để đưa ra phân tích danh mục ngắn gọn.

YÊU CẦU ĐỊNH DẠNG (bắt buộc):
- Trả lời bằng TIẾNG VIỆT, giọng điệu chuyên nghiệp của một chuyên gia phân tích.
- Phân tích ngắn gọn 2–4 câu (tóm tắt thị trường + đánh giá danh mục).
- Kết thúc bằng MỘT khuyến nghị rõ ràng, cụ thể (mua/bán/giữ, mã cổ phiếu, mức tỷ trọng).
- Trả về duy nhất một khối JSON hợp lệ, không thêm văn bản khác, theo đúng schema:
{"summary": "<2-4 câu phân tích tiếng Việt>", "recommendation": "<một khuyến nghị cụ thể>", "confidence": "LOW" | "MEDIUM" | "HIGH"}`;

interface ParsedAnalysis {
  summary: string;
  recommendation: string;
  confidence: string;
}

/** Extract the first JSON object from an LLM response (handles ```json fences). */
function parseAnalysis(raw: string): ParsedAnalysis {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const brace = candidate.match(/\{[\s\S]*\}/);
  if (brace) {
    try {
      const obj = JSON.parse(brace[0]) as Partial<ParsedAnalysis>;
      if (obj.summary || obj.recommendation) {
        return {
          summary: typeof obj.summary === "string" ? obj.summary : text,
          recommendation:
            typeof obj.recommendation === "string" ? obj.recommendation : "",
          confidence:
            typeof obj.confidence === "string" &&
            ["LOW", "MEDIUM", "HIGH"].includes(obj.confidence)
              ? obj.confidence
              : "MEDIUM",
        };
      }
    } catch {
      // fall through to raw text
    }
  }
  return { summary: text, recommendation: "", confidence: "MEDIUM" };
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** POST /api/agents/run — run one AI analysis cycle as portfolio-strategist. */
export async function POST() {
  const startedAt = Date.now();

  let agent: { id: string; code: string } | null = null;
  try {
    agent = await db.agent.findUnique({
      where: { code: AGENT_CODE },
      select: { id: true, code: true },
    });
    if (!agent) {
      return NextResponse.json(
        { error: "Không tìm thấy agent portfolio-strategist." },
        { status: 404 }
      );
    }

    // Mark agent RUNNING while the cycle executes
    await db.agent.update({
      where: { id: agent.id },
      data: { status: "RUNNING" },
    });

    // ── Build compact market snapshot ────────────────────────────────
    const [instruments, positions, alerts] = await Promise.all([
      db.instrument.findMany({
        where: { isActive: true },
        select: {
          symbol: true,
          quotes: {
            orderBy: { tradedAt: "desc" },
            take: 1,
            select: { last: true, change: true, changePct: true, volume: true },
          },
        },
      }),
      db.position.findMany({
        where: { status: "OPEN" },
        include: {
          instrument: {
            select: {
              symbol: true,
              quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true, changePct: true } },
            },
          },
        },
      }),
      db.riskAlert.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { severity: true, message: true },
      }),
    ]);

    const rows = instruments
      .map((i) => {
        const q = i.quotes[0];
        return q
          ? { symbol: i.symbol, last: q.last, changePct: q.changePct, volume: q.volume }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.volume - a.volume);

    const advancing = rows.filter((r) => r.changePct > 0).length;
    const declining = rows.filter((r) => r.changePct < 0).length;
    const avgChangePct = rows.length
      ? rows.reduce((s, r) => s + r.changePct, 0) / rows.length
      : 0;
    const gainers = [...rows].sort((a, b) => b.changePct - a.changePct).slice(0, 5);
    const losers = [...rows].sort((a, b) => a.changePct - b.changePct).slice(0, 5);

    const positionLines = positions.map((p) => {
      const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
      const pnl = (last - p.avgPrice) * p.quantity;
      const pnlPct =
        p.avgPrice > 0 ? ((last - p.avgPrice) / p.avgPrice) * 100 : 0;
      return `- ${p.instrument.symbol}: ${p.quantity} cp @ ${p.avgPrice} → ${last} ₫ | L/L: ${Math.round(pnl).toLocaleString("vi-VN")} ₫ (${pnlPct.toFixed(2)}%)`;
    });

    const snapshot = [
      "SNAPSHOT THỊ TRƯỜNG VN30 (HOSE) — HIỆN TẠI",
      `- Số mã: ${rows.length} | Tăng: ${advancing} | Giảm: ${declining} | Biến động TB: ${avgChangePct.toFixed(2)}%`,
      `- Top tăng: ${gainers.map((g) => `${g.symbol} ${g.changePct.toFixed(2)}%`).join(", ")}`,
      `- Top giảm: ${losers.map((g) => `${g.symbol} ${g.changePct.toFixed(2)}%`).join(", ")}`,
      "",
      "DANH MỤC ĐANG NẮM GIỮ",
      positionLines.length ? positionLines.join("\n") : "- (trống)",
      "",
      "CẢNH BÁO RỦI RO GẦN NHẤT",
      alerts.length
        ? alerts.map((a) => `- [${a.severity}] ${a.message}`).join("\n")
        : "- (không có)",
      "",
      "Hãy phân tích và đưa ra khuyến nghị theo đúng định dạng JSON đã yêu cầu.",
    ].join("\n");

    // ── Call the LLM via z-ai-web-dev-sdk ────────────────────────────
    let summary = "";
    let recommendation = "";
    let confidence = "MEDIUM";
    let tokensIn = estimateTokens(SYSTEM_PROMPT + snapshot);
    let tokensOut = 0;

    try {
      const zai = await ZAI.create();
      const completion = await zai.chat.completions.create({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: snapshot },
        ],
      });

      const raw: string = completion?.choices?.[0]?.message?.content ?? "";
      if (!raw) throw new Error("Phản hồi trống từ mô hình AI.");
      const parsed = parseAnalysis(raw);
      summary = parsed.summary;
      recommendation = parsed.recommendation;
      confidence = parsed.confidence;

      const usage = completion?.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;
      tokensIn = usage?.prompt_tokens ?? tokensIn;
      tokensOut = usage?.completion_tokens ?? estimateTokens(raw);
    } catch (sdkErr) {
      // SDK failure → FAILED run, agent ERROR, friendly 500
      console.error("[api/agents/run] SDK error:", sdkErr);
      const durationMs = Date.now() - startedAt;
      await db.agentRun.create({
        data: {
          agentId: agent.id,
          taskStatus: "FAILED",
          startedAt: new Date(startedAt),
          finishedAt: new Date(),
          durationMs,
          tokensIn,
          tokensOut: 0,
          costUsd: 0,
          error:
            sdkErr instanceof Error ? sdkErr.message : "Lỗi không xác định từ mô hình AI.",
        },
      });
      await db.agent.update({
        where: { id: agent.id },
        data: { status: "ERROR", lastRunAt: new Date() },
      });
      return NextResponse.json(
        {
          error:
            "Agent chưa gọi được mô hình AI lúc này. Vui lòng thử lại sau ít phút.",
        },
        { status: 500 }
      );
    }

    // ── Persist message + run, restore agent to IDLE ─────────────────
    const finishedAt = new Date();
    const durationMs = Date.now() - startedAt;
    const costUsd = Number(((tokensIn * 0.6 + tokensOut * 2.2) / 1_000_000).toFixed(6));

    const [message] = await db.$transaction([
      db.agentMessage.create({
        data: {
          fromAgentId: agent.id,
          broadcast: true,
          content: summary,
          reasoning: recommendation || null,
          sentiment:
            confidence === "HIGH" ? "bullish" : confidence === "LOW" ? "neutral" : "neutral",
        },
      }),
    ]);

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
        output: JSON.stringify({ summary, recommendation, confidence }),
      },
    });

    await db.agent.update({
      where: { id: agent.id },
      data: { status: "IDLE", lastRunAt: finishedAt },
    });

    const fromAgent = await db.agent.findUnique({
      where: { id: agent.id },
      select: { code: true, name: true, role: true },
    });

    return NextResponse.json(
      toPlain({
        message: {
          id: message.id,
          fromAgent,
          toAgent: null,
          broadcast: true,
          content: message.content,
          reasoning: message.reasoning,
          sentiment: message.sentiment,
          createdAt: message.createdAt,
        },
        run: {
          id: run.id,
          taskStatus: run.taskStatus,
          durationMs: run.durationMs,
          tokensIn: run.tokensIn,
          tokensOut: run.tokensOut,
          costUsd: run.costUsd,
          error: run.error,
        },
      })
    );
  } catch (err) {
    // Absolute last-resort guard — never crash the app
    console.error("[api/agents/run] unexpected error:", err);
    if (agent) {
      try {
        await db.agentRun.create({
          data: {
            agentId: agent.id,
            taskStatus: "FAILED",
            startedAt: new Date(startedAt),
            finishedAt: new Date(),
            durationMs: Date.now() - startedAt,
            error: err instanceof Error ? err.message : "Lỗi hệ thống.",
          },
        });
        await db.agent.update({
          where: { id: agent.id },
          data: { status: "ERROR", lastRunAt: new Date() },
        });
      } catch {
        // swallow — logging already happened
      }
    }
    return NextResponse.json(
      { error: "Chu kỳ phân tích gặp lỗi không mong muốn. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
