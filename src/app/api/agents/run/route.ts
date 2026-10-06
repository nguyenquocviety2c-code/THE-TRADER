import { NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { pctChange, rsi, sma, latestVsMean } from "@/lib/indicators";
import { updateAgentHealth } from "@/lib/health";
import { latestNewsForContext } from "@/lib/news";
import { getForeignFlows, flowsPromptBlock } from "@/lib/flows";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/agents/run — full multi-agent analysis cycle
 * (TECHNICAL_BLUEPRINT §5.2):
 *
 *  1. Snapshot: quotes, 90-day bars (top liquid), positions, account, risk alerts
 *  2. Build role prompts from each Agent.config
 *  3. Run 3 analysis agents in parallel (market / news / risk) → AgentMessage + AgentRun
 *  4. Portfolio Strategist consolidates → AgentMessage + AgentRun + Signal
 *  5. Execution Manager (deterministic) → paper Order + AgentMessage + AgentRun
 *  6. AuditLog: SIGNAL_APPROVED · ORDER_CREATED · AGENT_RUN_COMPLETED
 */

const ANALYST_CODES = ["market-analyst", "news-sentiment", "risk-manager"] as const;
const STRATEGIST_CODE = "portfolio-strategist";
const EXECUTOR_CODE = "execution-manager";
const ALL_CODES = [...ANALYST_CODES, STRATEGIST_CODE, EXECUTOR_CODE] as const;

/** F-203 (audit 19-b): rate-limit chu kỳ — chống spam chi phí LLM không giới hạn. */
const CYCLE_COOLDOWN_MS = 60_000;
let lastCycleStartedAt = 0;

/** Position sizing for the paper execution step: 5% of equity, board lots of 100. */
const POSITION_SIZE_PCT = 0.05;

function round100(v: number): number {
  return Math.max(0, Math.round(v / 100) * 100);
}

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

/**
 * LLM call with one retry on rate limit (429) — the SDK enforces a
 * low concurrent-request budget, so agent calls run sequentially.
 */
async function callLlmWithRetry(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  systemPrompt: string,
  userPrompt: string
): Promise<{ raw: string; tokensIn: number; tokensOut: number }> {
  try {
    return await callLlm(zai, systemPrompt, userPrompt);
  } catch (err) {
    const isRateLimit =
      err instanceof Error && err.message.includes("429");
    if (!isRateLimit) throw err;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return callLlm(zai, systemPrompt, userPrompt);
  }
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
    // ── 1. Snapshot ────────────────────────────────────────────────
    const [instruments, positions, alerts, account] = await Promise.all([
      db.instrument.findMany({
        where: { isActive: true },
        select: {
          id: true,
          symbol: true,
          sector: true,
          quotes: {
            orderBy: { tradedAt: "desc" },
            take: 1,
            select: { last: true, change: true, changePct: true, volume: true, floorPrice: true, ceilingPrice: true },
          },
        },
      }),
      db.position.findMany({
        where: { status: "OPEN" },
        include: {
          instrument: {
            select: {
              symbol: true,
              sector: true,
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
      db.brokerAccount.findFirst({
        where: { deletedAt: null },
        select: { id: true, cashBalance: true, equity: true, marginUsed: true },
      }),
    ]);

    // ── S5/S6 context — news RSS + foreign flows (DATA_SOURCES.md §4.3/§4.4) ──
    const [newsItems, flows] = await Promise.all([
      latestNewsForContext(10),
      getForeignFlows().catch(() => null),
    ]);

    const quoteRows = instruments
      .map((i) => {
        const q = i.quotes[0];
        return q
          ? { id: i.id, symbol: i.symbol, sector: i.sector, ...q }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.volume - a.volume);

    const advancing = quoteRows.filter((r) => r.changePct > 0).length;
    const declining = quoteRows.filter((r) => r.changePct < 0).length;
    const avgChangePct = quoteRows.length
      ? quoteRows.reduce((s, r) => s + r.changePct, 0) / quoteRows.length
      : 0;
    const totalVolume = quoteRows.reduce((s, r) => s + r.volume, 0);
    const gainers = [...quoteRows].sort((a, b) => b.changePct - a.changePct).slice(0, 5);
    const losers = [...quoteRows].sort((a, b) => a.changePct - b.changePct).slice(0, 5);

    // ── Technical indicators for the top-10 liquid symbols ─────────
    const top10 = quoteRows.slice(0, 10);
    const barRows = await db.bar.findMany({
      where: { instrumentId: { in: top10.map((t) => t.id) } },
      orderBy: { date: "asc" },
      select: { instrumentId: true, close: true, volume: true },
    });
    const barsByInstrument = new Map<string, { closes: number[]; volumes: number[] }>();
    for (const b of barRows) {
      let entry = barsByInstrument.get(b.instrumentId);
      if (!entry) {
        entry = { closes: [], volumes: [] };
        barsByInstrument.set(b.instrumentId, entry);
      }
      entry.closes.push(b.close);
      entry.volumes.push(b.volume);
    }
    const lastById = new Map(quoteRows.map((r) => [r.id, r.last]));
    const floorById = new Map(quoteRows.map((r) => [r.id, r.floorPrice ?? 0]));
    const ceilingById = new Map(quoteRows.map((r) => [r.id, r.ceilingPrice ?? 0]));
    const indicatorLines = top10.map((t) => {
      const bars = barsByInstrument.get(t.id);
      const closes = bars?.closes ?? [];
      const last = lastById.get(t.id) ?? (closes.length ? closes[closes.length - 1] : 0);
      const sma20 = sma(closes, 20);
      const sma50 = sma(closes, 50);
      const rsi14 = rsi(closes, 14);
      const chg5d = closes.length >= 6 ? pctChange(closes[closes.length - 6], last) : null;
      const volRatio = bars ? latestVsMean(bars.volumes, 20) : null;
      return [
        `${t.symbol} (${t.sector ?? "—"})`,
        `giá ${last.toLocaleString("vi-VN")}`,
        `HG ${t.changePct >= 0 ? "+" : ""}${t.changePct.toFixed(2)}%`,
        `SMA20 ${sma20 != null ? Math.round(sma20).toLocaleString("vi-VN") : "—"}`,
        `SMA50 ${sma50 != null ? Math.round(sma50).toLocaleString("vi-VN") : "—"}`,
        `RSI14 ${rsi14 != null ? rsi14.toFixed(0) : "—"}`,
        `5 phiên ${chg5d != null ? (chg5d >= 0 ? "+" : "") + chg5d.toFixed(2) + "%" : "—"}`,
        `KL/TL20 ${volRatio ?? "—"}`,
      ].join(" · ");
    });

    const positionLines = positions.map((p) => {
      const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
      const pnl = (last - p.avgPrice) * p.quantity;
      const pnlPct = p.avgPrice > 0 ? ((last - p.avgPrice) / p.avgPrice) * 100 : 0;
      return `- ${p.instrument.symbol} (${p.instrument.sector ?? "—"}): ${p.quantity} cp @ ${p.avgPrice.toLocaleString("vi-VN")} → ${last.toLocaleString("vi-VN")} ₫ | Lãi/lỗ: ${Math.round(pnl).toLocaleString("vi-VN")} ₫ (${pnlPct.toFixed(2)}%)`;
    });

    // F-102 (audit 19-a): tổng tài sản = tiền mặt + GTTH vị thế mở (equity trong DB chỉ là snapshot seed)
    const positionsMv = positions.reduce(
      (s, p) => s + (p.instrument.quotes[0]?.last ?? p.avgPrice) * p.quantity,
      0
    );
    const equity = account
      ? Number(account.cashBalance) + positionsMv
      : 0;
    const sectorWeights = new Map<string, number>();
    for (const p of positions) {
      const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
      const mv = last * p.quantity;
      sectorWeights.set(
        p.instrument.sector ?? "Khác",
        (sectorWeights.get(p.instrument.sector ?? "Khác") ?? 0) + mv
      );
    }
    const sectorLines = [...sectorWeights.entries()]
      .map(([sector, mv]) => {
        const pct = equity > 0 ? (mv / equity) * 100 : 0;
        return `- ${sector}: ${Math.round(mv).toLocaleString("vi-VN")} ₫ (~${pct.toFixed(1)}% NAV)`;
      })
      .sort((a, b) => b.localeCompare(a));

    const marketBlock = [
      "SNAPSHOT THỊ TRƯỜNG VN30 (HOSE) — PHIÊN HIỆN TẠI",
      `- Số mã: ${quoteRows.length} | Tăng: ${advancing} | Giảm: ${declining} | Biến động TB: ${avgChangePct.toFixed(2)}%`,
      `- Tổng khối lượng: ${totalVolume.toLocaleString("vi-VN")} cp`,
      `- Top tăng: ${gainers.map((g) => `${g.symbol} +${g.changePct.toFixed(2)}%`).join(", ")}`,
      `- Top giảm: ${losers.map((g) => `${g.symbol} ${g.changePct.toFixed(2)}%`).join(", ")}`,
      "",
      "BẢNG CHỈ BÁO KỸ THUẬT (10 mã thanh khoản cao nhất, 90 phiên):",
      ...indicatorLines,
      "",
      "DANH MỤC ĐANG NẮM GIỮ:",
      positionLines.length ? positionLines.join("\n") : "- (trống)",
      "",
      "TỶ TRỌNG NGÀNH (theo NAV):",
      ...sectorLines,
      "",
      "TÀI KHOẢN VNDIRECT (paper):",
      `- Giá trị tài sản: ${equity.toLocaleString("vi-VN")} ₫ | Tiền mặt: ${account ? Number(account.cashBalance).toLocaleString("vi-VN") : 0} ₫ | Margin: ${account ? Number(account.marginUsed).toLocaleString("vi-VN") : 0} ₫`,
      "",
      "CẢNH BÁO RỦI RO GẦN NHẤT:",
      alerts.length ? alerts.map((a) => `- [${a.severity}] ${a.message}`).join("\n") : "- (không có)",
    ].join("\n");

    // ── S5 news block + S6 flows block (đưa vào prompt đúng agent) ──
    const newsAge = (d: Date) => {
      const h = Math.max(0, Math.round((Date.now() - d.getTime()) / 3_600_000));
      return h <= 0 ? "vừa xong" : h < 24 ? `${h}h trước` : `${Math.round(h / 24)} ngày trước`;
    };
    const newsBlock = newsItems.length
      ? [
          `TIN TỨC THỊ TRƯỜNG MỚI NHẤT (S5 · RSS ${[...new Set(newsItems.map((n) => n.source))].join(", ")}):`,
          ...newsItems.map(
            (n) =>
              `- [${n.source} · ${newsAge(n.publishedAt)}] ${n.title}${n.summary ? ` — ${n.summary.slice(0, 140)}` : ""}`
          ),
        ].join("\n")
      : "TIN TỨC THỊ TRƯỜNG: (chưa nạp được tin mới — nếu dùng, khai báo rõ 'no new data' và không bịa tin)";
    const flowsBlock = flows
      ? flowsPromptBlock(flows)
      : "DÒNG KHỐI NGOẠI: (nguồn không khả dụng — bỏ metric này khỏi phân tích)";

    // ── 2. Role prompts (from Agent.config) ───────────────────────
    const cfg = (code: string): Record<string, unknown> => {
      try {
        return JSON.parse(byCode.get(code)?.config ?? "{}") as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    const lookback = (cfg("market-analyst").lookbackDays as number) ?? 90;
    const indicatorsList = ((cfg("market-analyst").indicators as string[]) ?? [
      "SMA20",
      "SMA50",
      "RSI14",
    ]).join(", ");
    const riskCfg = cfg("risk-manager");

    const prompts: Record<string, { system: string; user: string }> = {
      "market-analyst": {
        system: `Bạn là agent "Market Analyst" của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: phân tích kỹ thuật bảng chỉ báo OHLCV VN30 (${lookback} phiên, chỉ báo: ${indicatorsList}).
Yêu cầu: trả lời bằng TIẾNG VIỆT, 2–4 câu đúng trọng tâm; đánh giá xu hướng tổng thể và nêu 2–3 mã nổi bật nhất kèm số liệu cụ thể; KHÔNG bịa số liệu ngoài bảng.
Trả về duy nhất một khối JSON hợp lệ: {"content": "<phân tích 2-4 câu>", "reasoning": "<1 câu cơ sở kỹ thuật>"}`,
        user: [marketBlock, flowsBlock].join("\n\n"),
      },
      "news-sentiment": {
        system: `Bạn là agent "News & Sentiment" của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
QUAN TRỌNG: nguồn tin tức ngoài (RSS VnEconomy/CafeF/VNExpress/Tuổi Trẻ/VietnamNet) ĐÃ được tích hợp — khối TIN TỨC THỊ TRƯỜNG MỚI NHẤT nằm ở cuối prompt người dùng; hãy chấm cảm xúc chung của dòng tin (bullish/bearish/neutral) và nêu 1–2 tin ảnh hưởng lớn nhất tới VN30. Nếu khối tin ghi "chưa nạp được" → khai báo rõ "no new data" và chỉ suy luận hạn chế từ số liệu nội tại. Tuyệt đối không bịa tin tức.
Trả lời TIẾNG VIỆT, 2–3 câu. Trả về duy nhất JSON: {"content": "...", "reasoning": "...", "sentiment": "bullish" | "bearish" | "neutral"}`,
        user: [marketBlock, newsBlock, flowsBlock].join("\n\n"),
      },
      "risk-manager": {
        system: `Bạn là agent "Risk Manager" của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: đối chiếu danh mục với giới hạn rủi ro: drawdown tối đa ${riskCfg.maxDrawdownPct ?? 15}%, tỷ trọng ngành tối đa ${riskCfg.maxSectorWeightPct ?? 40}%, vị thế đơn tối đa ${riskCfg.maxPositionPct ?? 25}% NAV, lỗ ngày tối đa ${((riskCfg.dailyLossLimitVnd as number) ?? 50000000).toLocaleString("vi-VN")} ₫.
Kiểm tra từng giới hạn, nêu rõ vi phạm (nếu có), và kết luận mức rủi ro tổng thể của danh mục.
Trả lời TIẾNG VIỆT, 2–4 câu. Trả về duy nhất JSON: {"content": "...", "reasoning": "<cơ sở tính toán>"}`,
        user: [marketBlock, flowsBlock].join("\n\n"),
      },
      "portfolio-strategist": {
        system: `Bạn là agent "Portfolio Strategist" (điểm hợp lưu) của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: tổng hợp 3 bản phân tích của Market Analyst, News & Sentiment, và Risk Manager ở trên để (a) đưa ra nhận định danh mục ngắn gọn, (b) sinh MỘT tín hiệu giao dịch cụ thể.
Quy tắc tín hiệu: chỉ chọn mã có trong bảng chỉ báo; direction BUY chỉ khi xu hướng + cảm xúc + rủi ro đều thuận, SELL khi cần cắt tỷ trọng vi phạm giới hạn, còn lại HOLD; score 0–100; giá là số nguyên VND bội số 100; BUY: stopLoss < giá hiện tại < targetPrice < takeProfit; SELL: targetPrice < giá hiện tại < stopLoss.
Trả về duy nhất JSON: {"summary": "<2-4 câu tổng hợp>", "recommendation": "<một khuyến nghị cụ thể>", "confidence": "LOW"|"MEDIUM"|"HIGH", "signal": {"symbol": "VCB", "direction": "BUY"|"SELL"|"HOLD", "score": 0-100, "rationale": "...", "targetPrice": <int VND|null>, "stopLoss": <int VND|null>, "takeProfit": <int VND|null>} | null}`,
        user: [marketBlock, newsBlock, flowsBlock].join("\n\n"),
      },
    };

    // ── 3. Three analysis agents — sequential (SDK rate limits concurrency) ──
    const zai = await ZAI.create();
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
          zai,
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
      marketBlock,
      "",
      newsBlock,
      flowsBlock,
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
        zai,
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

    // ── 5. Execution Manager — deterministic paper order ─────────
    const executorAgent = byCode.get(EXECUTOR_CODE)!;
    let createdSignal: {
      id: string;
      symbol: string;
      direction: string;
      score: number;
      confidence: string;
    } | null = null;
    let createdOrder: {
      id: string;
      symbol: string;
      side: string;
      quantity: number;
      price: number | null;
      status: string;
    } | null = null;
    let executionRunId = "";
    let signalExpiresAt: Date | null = null;

    const validSymbol = strategist?.signal
      ? quoteRows.find(
          (r) => r.symbol === strategist.signal?.symbol
        )
      : undefined;

    if (strategist?.signal && validSymbol) {
      const sig = strategist.signal;
      const lastPrice = lastById.get(validSymbol.id) ?? 0;
      const expiresAt = new Date(Date.now() + 3 * 86_400_000);
      signalExpiresAt = expiresAt;

      const signalRow = await db.signal.create({
        data: {
          instrumentId: validSymbol.id,
          direction: sig.direction,
          confidence: sig.confidence,
          score: sig.score,
          rationale: sig.rationale,
          agentId: strategistAgent.id,
          targetPrice: sig.direction === "HOLD" ? null : sig.targetPrice,
          stopLoss: sig.direction === "BUY" ? sig.stopLoss : null,
          takeProfit: sig.direction === "BUY" ? sig.takeProfit : null,
          expiresAt,
        },
      });
      createdSignal = {
        id: signalRow.id,
        symbol: sig.symbol,
        direction: sig.direction,
        score: sig.score,
        confidence: sig.confidence,
      };
      await db.auditLog.create({
        data: {
          action: "SIGNAL_APPROVED",
          entity: "Signal",
          entityId: signalRow.id,
          after: JSON.stringify({
            symbol: sig.symbol,
            direction: sig.direction,
            score: sig.score,
          }),
        },
      });

      // Paper order for BUY/SELL signals (5% of equity, board lots of 100)
      let executionContent = "";
      if (sig.direction !== "HOLD" && lastPrice > 0 && equity > 0) {
        const rawQty = Math.floor((equity * POSITION_SIZE_PCT) / lastPrice);
        const quantity = Math.max(100, Math.floor(rawQty / 100) * 100);
        // F-202 (audit 19-b): giá lệnh luôn nằm trong dải trần/sàn ±7% (Q2) + bội 100 ₫
        const bandLow = floorById.get(validSymbol.id) || round100(lastPrice * 0.93);
        const bandHigh = ceilingById.get(validSymbol.id) || round100(lastPrice * 1.07);
        const basePrice = sig.targetPrice && sig.targetPrice > 0
          ? sig.direction === "BUY"
            ? Math.min(sig.targetPrice, round100(lastPrice * 1.01))
            : Math.max(sig.targetPrice, round100(lastPrice * 0.99))
          : round100(lastPrice);
        const orderPrice = Math.max(bandLow, Math.min(basePrice, bandHigh));

        const [user] = await db.user.findMany({
          where: { isActive: true },
          select: { id: true },
          take: 1,
        });
        const brokerAccount = await db.brokerAccount.findFirst({
          where: { deletedAt: null },
          select: { id: true },
        });

        const order = await db.order.create({
          data: {
            userId: user?.id ?? "system",
            brokerAccountId: brokerAccount?.id ?? null,
            signalId: signalRow.id,
            instrumentId: validSymbol.id,
            side: sig.direction,
            type: "LIMIT",
            quantity,
            price: orderPrice,
            fee: BigInt(Math.round(0.0015 * orderPrice * quantity)), // F-201 (audit 19-b): phí môi giới 0,15% notional
            status: "PENDING",
            note: "Tự động từ chu kỳ agent",
          },
        });
        await db.signal.update({
          where: { id: signalRow.id },
          data: { actedAt: new Date() },
        });
        await db.auditLog.create({
          data: {
            userId: user?.id ?? null,
            action: "ORDER_CREATED",
            entity: "Order",
            entityId: order.id,
            after: JSON.stringify({
              symbol: sig.symbol,
              side: sig.direction,
              quantity,
              price: orderPrice,
            }),
          },
        });
        createdOrder = {
          id: order.id,
          symbol: sig.symbol,
          side: sig.direction,
          quantity,
          price: orderPrice,
          status: "PENDING",
        };
        executionContent = `Nhận tín hiệu ${sig.direction === "BUY" ? "MUA" : "BÁN"} ${sig.symbol} (điểm ${sig.score}/100, tin cậy ${sig.confidence}). Đã đặt lệnh giấy LIMIT ${orderPrice.toLocaleString("vi-VN")} ₫ × ${quantity.toLocaleString("vi-VN")} cp (~${(POSITION_SIZE_PCT * 100).toFixed(0)}% NAV, làm tròn lô 100) — trạng thái PENDING, chờ khớp mô phỏng.`;
      } else {
        executionContent = `Nhận tín hiệu ${sig.direction === "HOLD" ? "GIỮ" : sig.direction} ${sig.symbol} (điểm ${sig.score}/100). Không tạo lệnh mới${sig.direction === "HOLD" ? " (tín hiệu GIỮ)" : ""}.`;
      }

      const execStart = Date.now();
      const execRun = await persistRun(
        executorAgent.id,
        true,
        execStart,
        0,
        0,
        JSON.stringify({ signalId: signalRow.id, order: createdOrder?.id ?? null }),
        null
      );
      executionRunId = execRun.id;
      const execMessage = await persistMessage(
        executorAgent.id,
        executionContent,
        `Sizing ${(POSITION_SIZE_PCT * 100).toFixed(0)}% NAV · lô 100 cp · LIMIT`,
        null
      );
      createdMessages.push({
        id: execMessage.id,
        fromAgentId: executorAgent.id,
        content: executionContent,
        reasoning: `Sizing ${(POSITION_SIZE_PCT * 100).toFixed(0)}% NAV · lô 100 cp · LIMIT`,
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
          order: createdOrder?.symbol ?? null,
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
        order: createdOrder,
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
