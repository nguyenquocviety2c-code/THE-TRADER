import { db } from "@/lib/db";
import { pctChange, rsi, sma, latestVsMean } from "@/lib/indicators";
import { latestNewsForContext } from "@/lib/news";
import { getForeignFlows, flowsPromptBlock } from "@/lib/flows";

/**
 * Khối ngữ cảnh + role-prompt DÙNG CHUNG cho single-run & chat
 * (PHASE3_BLUEPRINT §4.6) — trích xuất từ POST /api/agents/run.
 *
 * Các builder lấy dữ liệu thật từ DB (quotes/positions/account/news/flows);
 * không bao giờ bịa số liệu. equity = cash + Σ(qty×last) vị thế mở (F-102).
 */

/** Kết quả snapshot thị trường — kèm map symbol → instrumentId để validate tín hiệu. */
export interface MarketSnapshot {
  /** Khối prompt đầy đủ (chu kỳ / single-run). */
  block: string;
  /** Bản rút gọn ~15 dòng cho chat (§4.4). */
  compact: string;
  /** equity = cash + Σ(qty × last) vị thế mở (F-102). */
  equity: number;
  /** symbol → instrumentId của các mã có báo giá (để đối chiếu tín hiệu strategist). */
  instrumentIdBySymbol: Map<string, string>;
}

/** Snapshot VN30 + bảng chỉ báo top-10 + danh mục + tài khoản + cảnh báo rủi ro. */
export async function buildMarketBlock(): Promise<MarketSnapshot> {
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

  const quoteRows = instruments
    .map((i) => {
      const q = i.quotes[0];
      return q ? { id: i.id, symbol: i.symbol, sector: i.sector, ...q } : null;
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

  // ── Chỉ báo kỹ thuật top-10 thanh khoản (90 phiên) ──────────────────
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

  // F-102 (audit 19-a): tổng tài sản = tiền mặt + GTTH vị thế mở (equity DB chỉ là snapshot)
  const positionsMv = positions.reduce(
    (s, p) => s + (p.instrument.quotes[0]?.last ?? p.avgPrice) * p.quantity,
    0
  );
  const equity = account ? Number(account.cashBalance) + positionsMv : 0;
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

  const accountLine = `- Giá trị tài sản: ${equity.toLocaleString("vi-VN")} ₫ | Tiền mặt: ${account ? Number(account.cashBalance).toLocaleString("vi-VN") : 0} ₫ | Margin: ${account ? Number(account.marginUsed).toLocaleString("vi-VN") : 0} ₫`;

  const block = [
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
    accountLine,
    "",
    "CẢNH BÁO RỦI RO GẦN NHẤT:",
    alerts.length ? alerts.map((a) => `- [${a.severity}] ${a.message}`).join("\n") : "- (không có)",
  ].join("\n");

  // Bản rút gọn cho chat (§4.4): số mã/tăng/giảm + 5 dòng chỉ báo + 3 vị thế + tài khoản
  const compact = [
    "SNAPSHOT THỊ TRƯỜNG VN30 (HOSE) — RÚT GỌN",
    `- Số mã: ${quoteRows.length} | Tăng: ${advancing} | Giảm: ${declining} | Biến động TB: ${avgChangePct.toFixed(2)}%`,
    `- Top tăng: ${gainers.map((g) => `${g.symbol} +${g.changePct.toFixed(2)}%`).join(", ")}`,
    `- Top giảm: ${losers.map((g) => `${g.symbol} ${g.changePct.toFixed(2)}%`).join(", ")}`,
    "",
    "BẢNG CHỈ BÁO KỸ THUẬT (5 mã thanh khoản cao nhất, 90 phiên):",
    ...indicatorLines.slice(0, 5),
    "",
    "DANH MỤC ĐANG NẮM GIỮ (tối đa 3):",
    positionLines.length ? positionLines.slice(0, 3).join("\n") : "- (trống)",
    "",
    "TÀI KHOẢN VNDIRECT (paper):",
    accountLine,
  ].join("\n");

  return {
    block,
    compact,
    equity,
    instrumentIdBySymbol: new Map(quoteRows.map((r) => [r.symbol, r.id])),
  };
}

/** 10 tin RSS mới nhất (S5 · latestNewsForContext) — định dạng như run route. */
export async function buildNewsBlock(): Promise<string> {
  const newsItems = await latestNewsForContext(10);
  const newsAge = (d: Date) => {
    const h = Math.max(0, Math.round((Date.now() - d.getTime()) / 3_600_000));
    return h <= 0 ? "vừa xong" : h < 24 ? `${h}h trước` : `${Math.round(h / 24)} ngày trước`;
  };
  return newsItems.length
    ? [
        `TIN TỨC THỊ TRƯỜNG MỚI NHẤT (S5 · RSS ${[...new Set(newsItems.map((n) => n.source))].join(", ")}):`,
        ...newsItems.map(
          (n) =>
            `- [${n.source} · ${newsAge(n.publishedAt)}] ${n.title}${n.summary ? ` — ${n.summary.slice(0, 140)}` : ""}`
        ),
      ].join("\n")
    : "TIN TỨC THỊ TRƯỜNG: (chưa nạp được tin mới — nếu dùng, khai báo rõ 'no new data' và không bịa tin)";
}

/** Dòng khối ngoại (S6) — nguồn không khả dụng thì khai báo rõ để agent bỏ metric. */
export async function buildFlowsBlock(): Promise<string> {
  const flows = await getForeignFlows().catch(() => null);
  return flows
    ? flowsPromptBlock(flows)
    : "DÒNG KHỐI NGOẠI: (nguồn không khả dụng — bỏ metric này khỏi phân tích)";
}

/** Tín hiệu đang mở (status ACTIVE) — PHASE3_BLUEPRINT §4.6 khối "signals mở". */
export async function buildOpenSignalsBlock(): Promise<string> {
  const signals = await db.signal.findMany({
    where: { status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    take: 8,
    include: { instrument: { select: { symbol: true } } },
  });
  if (!signals.length) return "- (không có tín hiệu đang mở)";
  return signals
    .map((s) => {
      const rationale =
        s.rationale.length > 120 ? `${s.rationale.slice(0, 120).trimEnd()}…` : s.rationale;
      return `- ${s.instrument.symbol} ${s.direction} điểm ${s.score}/100 tin cậy ${s.confidence} — ${rationale}`;
    })
    .join("\n");
}

/** Câu khai báo chế độ nguồn — bắt buộc cuối mọi role-prompt (PHASE3_BLUEPRINT §4.6). */
const SOURCE_MODE_DECLARATION =
  "Dữ liệu thị trường hiện mang nhãn chế độ nguồn (simulated/live) — hãy khai báo chế độ trong câu trả lời khi liên quan.";

/**
 * Bản đồ role-prompt 4 agent (giữ tinh thần run route; ngưỡng mirror config seed
 * trong DB: lookback 90, indicators SMA20/SMA50/RSI14/MACD/BOLL, risk 15/40/25/50tr).
 */
export const ROLE_PROMPTS: Record<
  string,
  { system: string; systemCompact: string }
> = {
  "market-analyst": {
    system: `Bạn là agent "Market Analyst" của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: phân tích kỹ thuật bảng chỉ báo OHLCV VN30 (90 phiên, chỉ báo: SMA20, SMA50, RSI14, MACD, BOLL).
Yêu cầu: trả lời bằng TIẾNG VIỆT, 2–4 câu đúng trọng tâm; đánh giá xu hướng tổng thể và nêu 2–3 mã nổi bật nhất kèm số liệu cụ thể; KHÔNG bịa số liệu ngoài bảng.
Trả về duy nhất một khối JSON hợp lệ: {"content": "<phân tích 2-4 câu>", "reasoning": "<1 câu cơ sở kỹ thuật>"}
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Market Analyst" của hệ thống The Trader (VNDIRECT) — chuyên gia phân tích kỹ thuật VN30.
Trả lời tự do bằng TIẾNG VIỆT, 2–5 câu, bám sát dữ liệu thị trường được cung cấp; KHÔNG bịa số liệu ngoài dữ liệu.
${SOURCE_MODE_DECLARATION}`,
  },
  "news-sentiment": {
    system: `Bạn là agent "News & Sentiment" của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
QUAN TRỌNG: nguồn tin tức ngoài (RSS VnEconomy/CafeF/VNExpress/Tuổi Trẻ/VietnamNet) ĐÃ được tích hợp — khối TIN TỨC THỊ TRƯỜNG MỚI NHẤT nằm ở cuối prompt người dùng; hãy chấm cảm xúc chung của dòng tin (bullish/bearish/neutral) và nêu 1–2 tin ảnh hưởng lớn nhất tới VN30. Nếu khối tin ghi "chưa nạp được" → khai báo rõ "no new data" và chỉ suy luận hạn chế từ số liệu nội tại. Tuyệt đối không bịa tin tức.
Trả lời TIẾNG VIỆT, 2–3 câu. Trả về duy nhất JSON: {"content": "...", "reasoning": "...", "sentiment": "bullish" | "bearish" | "neutral"}
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "News & Sentiment" của hệ thống The Trader (VNDIRECT) — chuyên gia tin tức & cảm xúc thị trường.
Trả lời tự do bằng TIẾNG VIỆT, 2–5 câu; chấm cảm xúc chung (bullish/bearish/neutral) khi phù hợp; KHÔNG bịa tin tức hay số liệu ngoài dữ liệu được cung cấp.
${SOURCE_MODE_DECLARATION}`,
  },
  "risk-manager": {
    system: `Bạn là agent "Risk Manager" của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: đối chiếu danh mục với giới hạn rủi ro: drawdown tối đa 15%, tỷ trọng ngành tối đa 40%, vị thế đơn tối đa 25% NAV, lỗ ngày tối đa 50.000.000 ₫.
Kiểm tra từng giới hạn, nêu rõ vi phạm (nếu có), và kết luận mức rủi ro tổng thể của danh mục.
Trả lời TIẾNG VIỆT, 2–4 câu. Trả về duy nhất JSON: {"content": "...", "reasoning": "<cơ sở tính toán>"}
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Risk Manager" của hệ thống The Trader (VNDIRECT) — quản trị rủi ro danh mục.
Trả lời tự do bằng TIẾNG VIỆT, 2–5 câu; kiểm tra hạn mức (drawdown, tập trung ngành, tổn thất) dựa trên dữ liệu được cung cấp; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
  },
  "portfolio-strategist": {
    system: `Bạn là agent "Portfolio Strategist" (điểm hợp lưu) của hệ thống giao dịch đa tác tử The Trader (VNDIRECT, Việt Nam).
Nhiệm vụ: tổng hợp các bản phân tích của Market Analyst, News & Sentiment, và Risk Manager ở trên để (a) đưa ra nhận định danh mục ngắn gọn, (b) sinh MỘT tín hiệu giao dịch cụ thể.
Quy tắc tín hiệu: chỉ chọn mã có trong bảng chỉ báo; direction BUY chỉ khi xu hướng + cảm xúc + rủi ro đều thuận, SELL khi cần cắt tỷ trọng vi phạm giới hạn, còn lại HOLD; score 0–100; giá là số nguyên VND bội số 100; BUY: stopLoss < giá hiện tại < targetPrice < takeProfit; SELL: targetPrice < giá hiện tại < stopLoss.
Trả về duy nhất JSON: {"summary": "<2-4 câu tổng hợp>", "recommendation": "<một khuyến nghị cụ thể>", "confidence": "LOW"|"MEDIUM"|"HIGH", "signal": {"symbol": "VCB", "direction": "BUY"|"SELL"|"HOLD", "score": 0-100, "rationale": "...", "targetPrice": <int VND|null>, "stopLoss": <int VND|null>, "takeProfit": <int VND|null>} | null}
${SOURCE_MODE_DECLARATION}`,
    systemCompact: `Bạn là agent "Portfolio Strategist" của hệ thống The Trader (VNDIRECT) — chiến lược gia danh mục.
Trả lời tự do bằng TIẾNG VIỆT, 2–5 câu; tổng hợp dữ liệu thị trường/danh mục/tín hiệu đang mở thành nhận định và khuyến nghị cụ thể; KHÔNG bịa số liệu.
${SOURCE_MODE_DECLARATION}`,
  },
};

/**
 * Prompt chạy riêng 1 agent (PHASE3_BLUEPRINT §4.3) — chọn block theo vai:
 * market-analyst → [market, flows]; news → [market, news, flows];
 * risk → [market, flows]; strategist → [market, news, flows, tín hiệu đang mở].
 */
export async function buildSingleRunPrompt(
  code: string
): Promise<{ system: string; user: string }> {
  const role = ROLE_PROMPTS[code];
  if (!role) throw new Error(`Không có role-prompt cho agent "${code}".`);
  const [market, news, flows, openSignals] = await Promise.all([
    buildMarketBlock(),
    buildNewsBlock(),
    buildFlowsBlock(),
    buildOpenSignalsBlock(),
  ]);
  switch (code) {
    case "market-analyst":
    case "risk-manager":
      return { system: role.system, user: [market.block, flows].join("\n\n") };
    case "news-sentiment":
      return { system: role.system, user: [market.block, news, flows].join("\n\n") };
    case "portfolio-strategist":
      return {
        system: role.system,
        user: [market.block, news, flows, `TÍN HIỆU ĐANG MỞ:\n${openSignals}`].join("\n\n"),
      };
    default:
      throw new Error(`Agent "${code}" không hỗ trợ chạy riêng.`);
  }
}

/**
 * user-prompt cho chat (§4.4): câu hỏi + [BỐI CẢNH DỮ LIỆU MỚI NHẤT] rút gọn theo vai.
 */
export async function buildChatUserPrompt(code: string, question: string): Promise<string> {
  switch (code) {
    case "news-sentiment": {
      const [market, news] = await Promise.all([buildMarketBlock(), buildNewsBlock()]);
      return `${question}\n\n[BỐI CẢNH DỮ LIỆU MỚI NHẤT]\n${[market.compact, news].join("\n\n")}`;
    }
    case "portfolio-strategist": {
      const [market, openSignals] = await Promise.all([
        buildMarketBlock(),
        buildOpenSignalsBlock(),
      ]);
      return `${question}\n\n[BỐI CẢNH DỮ LIỆU MỚI NHẤT]\n${[market.compact, `TÍN HIỆU ĐANG MỞ:\n${openSignals}`].join("\n\n")}`;
    }
    case "market-analyst":
    case "risk-manager":
    default: {
      const market = await buildMarketBlock();
      return `${question}\n\n[BỐI CẢNH DỮ LIỆU MỚI NHẤT]\n${market.compact}`;
    }
  }
}
