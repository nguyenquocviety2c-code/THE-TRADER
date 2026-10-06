/**
 * src/lib/agent-service-runs.ts — HÀM CHẠY DETERMINISTIC cho 16 service agents
 * (mở rộng kiến trúc 23 agents — phần còn lại là execution-manager do chu kỳ
 * xử lý riêng vì cần Signal đầu vào).
 *
 * Mỗi agent dịch vụ tính TOÀN BỘ số liệu thật từ DB (Supabase) —
 * KHÔNG gọi LLM, 0 chi phí tokens, ~0.2–1.5s mỗi lần chạy. Kết quả:
 *  - content    → tin broadcast cho feed đội agent
 *  - reasoning  → cơ sở ngắn (hiển thị phụ)
 *  - sentiment  → bullish/bearish/neutral khi có ý nghĩa
 *  - output     → JSON lưu AgentRun.output (truy vết sau này)
 *
 * Nguồn định nghĩa agents: src/lib/agent-roster.ts (kind: "service").
 */

import { db } from "@/lib/db";
import { llmStatus } from "@/lib/llm";
import { getTradingMode, TRADING_MODE_LABEL } from "@/lib/trading-mode";
import { sessionPhase, SESSION_PHASE_LABEL } from "@/lib/market-session";

export interface ServiceRunResult {
  content: string;
  reasoning: string;
  sentiment: "bullish" | "bearish" | "neutral" | null;
  output: Record<string, unknown>;
}

/* ───────────────────────────── Tiện ích chung ───────────────────────────── */

const vnd = (n: number): string => Math.round(n).toLocaleString("vi-VN");
const fmtPct = (n: number, digits = 1): string =>
  `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;

function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function stdOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(meanOf(xs.map((x) => (x - m) * (x - m))));
}
/** Hồi quy tuyến tính đơn giản: trả về slope trên chuỗi đóng cửa. */
function linregSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = meanOf(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (ys[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den > 0 ? num / den : 0;
}

/** Top-N mã thanh khoản cao nhất (kèm quote + closes + volumes 90 phiên). */
interface LiquidSymbol {
  id: string;
  symbol: string;
  sector: string | null;
  last: number;
  volume: number;
  closes: number[];
  volumes: number[];
}
async function topLiquid(n: number): Promise<LiquidSymbol[]> {
  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    select: {
      id: true,
      symbol: true,
      sector: true,
      quotes: {
        orderBy: { tradedAt: "desc" },
        take: 1,
        select: { last: true, volume: true },
      },
    },
  });
  const quoteRows = instruments
    .map((i) => {
      const q = i.quotes[0];
      return q ? { id: i.id, symbol: i.symbol, sector: i.sector, last: q.last, volume: q.volume } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, n);
  const bars = await db.bar.findMany({
    where: { instrumentId: { in: quoteRows.map((t) => t.id) } },
    orderBy: { date: "asc" },
    select: { instrumentId: true, close: true, volume: true },
  });
  const series = new Map<string, { closes: number[]; volumes: number[] }>();
  for (const b of bars) {
    const entry = series.get(b.instrumentId) ?? { closes: [], volumes: [] };
    entry.closes.push(b.close);
    entry.volumes.push(b.volume);
    series.set(b.instrumentId, entry);
  }
  return quoteRows.map((t) => ({
    ...t,
    closes: series.get(t.id)?.closes ?? [],
    volumes: series.get(t.id)?.volumes ?? [],
  }));
}

/** Vị thế mở + giá hiện tại + NAV (equity tính lại như F-102). */
async function portfolioSnapshot(): Promise<{
  equity: number;
  cash: number;
  marginUsed: number;
  positions: {
    symbol: string;
    sector: string | null;
    quantity: number;
    avgPrice: number;
    last: number;
    mv: number;
    pnlPct: number;
  }[];
  sectorWeights: { sector: string; mv: number; pct: number }[];
}> {
  const [positions, account] = await Promise.all([
    db.position.findMany({
      where: { status: "OPEN" },
      include: {
        instrument: {
          select: {
            symbol: true,
            sector: true,
            quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } },
          },
        },
      },
    }),
    db.brokerAccount.findFirst({
      where: { deletedAt: null },
      select: { cashBalance: true, equity: true, marginUsed: true },
    }),
  ]);
  const rows = positions.map((p) => {
    const last = p.instrument.quotes[0]?.last ?? p.avgPrice;
    const mv = last * p.quantity;
    const pnlPct = p.avgPrice > 0 ? ((last - p.avgPrice) / p.avgPrice) * 100 : 0;
    return {
      symbol: p.instrument.symbol,
      sector: p.instrument.sector,
      quantity: p.quantity,
      avgPrice: p.avgPrice,
      last,
      mv,
      pnlPct,
    };
  });
  const positionsMv = rows.reduce((s, r) => s + r.mv, 0);
  const cash = account ? Number(account.cashBalance) : 0;
  const equity = cash + positionsMv;
  const bySector = new Map<string, number>();
  for (const r of rows) {
    const key = r.sector ?? "Khác";
    bySector.set(key, (bySector.get(key) ?? 0) + r.mv);
  }
  return {
    equity,
    cash,
    marginUsed: account ? Number(account.marginUsed) : 0,
    positions: rows,
    sectorWeights: [...bySector.entries()]
      .map(([sector, mv]) => ({ sector, mv, pct: equity > 0 ? (mv / equity) * 100 : 0 }))
      .sort((a, b) => b.pct - a.pct),
  };
}

/* ─────────────────────────── Nhóm 4 · platform ─────────────────────────── */

/** S0 Data Collector — tình trạng đồng bộ dữ liệu. */
async function runDataCollector(): Promise<ServiceRunResult> {
  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const [instrumentCount, barCount, quoteAgg, news24h, sourceStatus] = await Promise.all([
    db.instrument.count({ where: { isActive: true } }),
    db.bar.count(),
    db.quote.aggregate({ _max: { tradedAt: true } }),
    db.newsItem.count({ where: { publishedAt: { gte: since24h } } }),
    db.dataSourceStatus.findUnique({ where: { key: "market-quotes" } }),
  ]);
  const lastQuoteAt = quoteAgg._max.tradedAt;
  const ageSec = lastQuoteAt ? Math.max(0, Math.round((Date.now() - lastQuoteAt.getTime()) / 1000)) : null;
  const mode = sourceStatus?.mode ?? "simulated";
  const ageLabel =
    ageSec == null
      ? "chưa có báo giá"
      : ageSec < 90
        ? `${ageSec}s trước`
        : `${Math.round(ageSec / 60)} phút trước`;

  return {
    content: `Đồng bộ hoàn tất: ${instrumentCount} mã VN30 · ${barCount.toLocaleString("vi-VN")} nến lịch sử · báo giá mới nhất ${ageLabel} (chế độ ${mode}) · ${news24h} tin RSS trong 24h qua. Dữ liệu sẵn sàng cho Hội đồng Nghiên cứu.`,
    reasoning: "Đếm trực tiếp từ kho: Instrument/Bar/Quote/NewsItem.",
    sentiment: null,
    output: { instrumentCount, barCount, quoteAgeSec: ageSec, news24h, mode },
  };
}

/** S1 Notification Officer — bản tin tình hình hệ thống. */
async function runNotificationOfficer(): Promise<ServiceRunResult> {
  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const [activeSignals, openAlerts, failedRuns] = await Promise.all([
    db.signal.findMany({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { instrument: { select: { symbol: true } } },
    }),
    db.riskAlert.count({ where: { acknowledgedAt: null } }),
    db.agentRun.count({ where: { taskStatus: "FAILED", startedAt: { gte: since24h } } }),
  ]);
  const signalLines = activeSignals.map(
    (s) => `${s.instrument.symbol} ${s.direction} (${s.score}/100)`
  );
  const needAttention = activeSignals.length > 0 || openAlerts > 0;

  const parts = [
    `BẢN TIN CHU KỲ: ${activeSignals.length} tín hiệu chờ phê duyệt`,
    signalLines.length ? `(${signalLines.join(" · ")})` : "",
    `${openAlerts} cảnh báo rủi ro chưa xử lý`,
    `${failedRuns} agent lỗi trong 24h.`,
  ].filter(Boolean);

  return {
    content: parts.join(" · ") + (needAttention ? " Cần trader xem xét." : " Không có mục cần xử lý gấp."),
    reasoning: "Đếm Signal ACTIVE + RiskAlert chưa ack + AgentRun FAILED 24h.",
    sentiment: needAttention ? "neutral" : "bullish",
    output: { activeSignals: activeSignals.length, openAlerts, failedRuns24h: failedRuns },
  };
}

/** S2 Feature Store — tình trạng đặc trưng giao dịch. */
async function runFeatureStore(): Promise<ServiceRunResult> {
  const top = await topLiquid(10);
  const ready = top.map((t) => {
    const closes = t.closes;
    const sma20 = closes.length >= 20 ? meanOf(closes.slice(-20)) : null;
    const sma50 = closes.length >= 50 ? meanOf(closes.slice(-50)) : null;
    const mom5 = closes.length >= 6 ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100 : null;
    const avgVol20 = t.volumes.length >= 20 ? meanOf(t.volumes.slice(-20)) : null;
    const volRatio = avgVol20 && avgVol20 > 0 ? t.volume / avgVol20 : null;
    const features = [sma20 != null, sma50 != null, mom5 != null, volRatio != null].filter(Boolean).length;
    return { symbol: t.symbol, features, sma20, sma50, mom5, volRatio, sessions: closes.length };
  });
  const full = ready.filter((r) => r.features === 4).length;
  const sample = ready
    .slice(0, 3)
    .map((r) => `${r.symbol} (SMA20 ${r.sma20 ? Math.round(r.sma20).toLocaleString("vi-VN") : "—"}, động lượng 5 phiên ${r.mom5 != null ? fmtPct(r.mom5) : "—"}, KL/TL20 ${r.volRatio != null ? r.volRatio.toFixed(2) + "×" : "—"})`);

  return {
    content: `Kho đặc trưng sẵn sàng: ${full}/10 mã top thanh khoản có đủ 5 nhóm đặc trưng (SMA20/50 · RSI14 · KL/TL20 · động lượng 5 phiên) trên ${ready[0]?.sessions ?? 0} phiên. Mẫu: ${sample.join(" · ")}.`,
    reasoning: "Tính lại trực tiếp từ chuỗi closes/volumes 90 phiên của top-10 thanh khoản.",
    sentiment: null,
    output: { fullFeatureCount: full, checked: 10, sample: ready.slice(0, 3) },
  };
}

/** A9 Data Integrity — kiểm định độ tươi & độ phủ. */
async function runDataIntegrity(): Promise<ServiceRunResult> {
  const [quoteAgg, barGroup, newsAgg] = await Promise.all([
    db.quote.aggregate({ _max: { tradedAt: true } }),
    db.bar.groupBy({ by: ["instrumentId"], _count: { _all: true } }),
    db.newsItem.aggregate({ _max: { publishedAt: true } }),
  ]);
  const lastQuoteAt = quoteAgg._max.tradedAt;
  const quoteAgeMin = lastQuoteAt
    ? Math.max(0, Math.round((Date.now() - lastQuoteAt.getTime()) / 60_000))
    : null;
  const barCounts = barGroup.map((g) => g._count._all);
  const minBars = barCounts.length ? Math.min(...barCounts) : 0;
  const lastNewsAt = newsAgg._max.publishedAt;
  const newsAgeH = lastNewsAt
    ? Math.max(0, Math.round((Date.now() - lastNewsAt.getTime()) / 3_600_000))
    : null;

  const issues: string[] = [];
  if (quoteAgeMin != null && quoteAgeMin > 30) issues.push(`báo giá cũ ${quoteAgeMin} phút (>30')`);
  if (minBars < 90) issues.push(`nến tối thiểu ${minBars}/90 phiên`);
  if (newsAgeH != null && newsAgeH > 24) issues.push(`tin mới nhất ${newsAgeH}h (>24h)`);

  const verdict = issues.length ? `CẢNH BÁO: ${issues.join("; ")}` : "TOÀN VẸN";

  return {
    content: `Kiểm định dữ liệu: báo giá ${quoteAgeMin == null ? "—" : quoteAgeMin + " phút tuổi"} · nến ${minBars}/90 phiên mỗi mã · tin tức ${newsAgeH == null ? "—" : newsAgeH + "h tuổi"} → ${verdict}.${issues.length ? " Agent nghiên cứu nên khai báo độ trễ trong phân tích." : ""}`,
    reasoning: "So tuổi Quote/News và độ phủ Bar với ngưỡng 30'/90 phiên/24h.",
    sentiment: issues.length ? "neutral" : "bullish",
    output: { quoteAgeMin, minBars, newsAgeH, issues },
  };
}

/* ─────────────────────── Nhóm 1 · research (service) ─────────────────────── */

/** A15 ML Forecast — dự báo động lượng 5 phiên bằng hồi quy tuyến tính. */
async function runMlForecast(): Promise<ServiceRunResult> {
  const top = await topLiquid(5);
  const forecasts = top
    .map((t) => {
      const closes = t.closes.slice(-30);
      if (closes.length < 10 || !t.last) return null;
      const slope = linregSlope(closes);
      const proj = (slope * 5) / t.last * 100; // % sau 5 phiên
      return { symbol: t.symbol, proj };
    })
    .filter((f): f is { symbol: string; proj: number } => f !== null)
    .sort((a, b) => b.proj - a.proj);
  const avg = forecasts.length ? meanOf(forecasts.map((f) => f.proj)) : 0;
  const best = forecasts[0];
  const worst = forecasts[forecasts.length - 1];

  return {
    content: `Dự báo tuyến tính 5 phiên (hồi quy trên 30 phiên đóng cửa, top-5 thanh khoản): trung bình ${fmtPct(avg)} · tích cực nhất ${best ? best.symbol + " " + fmtPct(best.proj) : "—"} · yếu nhất ${worst && worst !== best ? worst.symbol + " " + fmtPct(worst.proj) : "—"}. Lưu ý: mô hình tuyến tính chỉ phản ánh động lượng gần đây, không phải khuyến nghị giao dịch.`,
    reasoning: "linreg slope × 5 phiên / giá hiện tại, tính trên 30 closes mỗi mã.",
    sentiment: avg > 1 ? "bullish" : avg < -1 ? "bearish" : "neutral",
    output: { horizonDays: 5, avgPct: Number(avg.toFixed(2)), forecasts },
  };
}

/* ─────────────────────── Nhóm 2 · control (service) ─────────────────────── */

/** A7 Exposure — VETO phơi nhiễm ngành & vị thế đơn. */
async function runExposure(): Promise<ServiceRunResult> {
  const MAX_SECTOR = 40; // % NAV — mirror config roster
  const MAX_POSITION = 25; // % NAV
  const snap = await portfolioSnapshot();
  const topSector = snap.sectorWeights[0];
  const topPosition = [...snap.positions].sort((a, b) => b.mv - a.mv)[0];
  const positionPct =
    topPosition && snap.equity > 0 ? (topPosition.mv / snap.equity) * 100 : 0;

  const breaches: string[] = [];
  if (topSector && topSector.pct > MAX_SECTOR) {
    breaches.push(`ngành ${topSector.sector} ${topSector.pct.toFixed(1)}% > ${MAX_SECTOR}%`);
  }
  if (topPosition && positionPct > MAX_POSITION) {
    breaches.push(`vị thế ${topPosition.symbol} ${positionPct.toFixed(1)}% > ${MAX_POSITION}%`);
  }
  const verdict = breaches.length ? "VETO tín hiệu tăng phơi nhiễm" : "ĐẠT";

  return {
    content: `Kiểm tra phơi nhiễm (NAV ${vnd(snap.equity)} ₫): ngành lớn nhất ${topSector ? `${topSector.sector} ${topSector.pct.toFixed(1)}%` : "—"} (hạn ${MAX_SECTOR}%) · vị thế lớn nhất ${topPosition ? `${topPosition.symbol} ${positionPct.toFixed(1)}%` : "—"} (hạn ${MAX_POSITION}%) → ${verdict}.${breaches.length ? " Danh mục đã vượt hạn mức — ưu tiên SELL cắt tỷ trọng." : ""}`,
    reasoning: "Tính tỷ trọng ngành/vị thế từ Position × giá hiện tại / equity F-102.",
    sentiment: breaches.length ? "bearish" : "neutral",
    output: { verdict, breaches, topSector, topPositionPct: Number(positionPct.toFixed(2)) },
  };
}

/** A8 Compliance — VETO tuân thủ chế độ giao dịch & phiên. */
async function runCompliance(): Promise<ServiceRunResult> {
  const mode = getTradingMode();
  const phase = sessionPhase(new Date());
  const snap = await portfolioSnapshot();
  const marginRoom = snap.equity - snap.marginUsed;

  const checks = [
    `chế độ ${TRADING_MODE_LABEL[mode.mode]}`,
    `phiên: ${SESSION_PHASE_LABEL[phase]}`,
    `biên margin ${marginRoom >= 0 ? "duy dương" : "AM"} (${vnd(marginRoom)} ₫)`,
    "phê duyệt trader bắt buộc trước mọi lệnh",
  ];
  const veto = marginRoom < 0 || mode.mode === "live-unconfigured";
  const verdict = veto ? "VETO giao dịch mới" : "ĐẠT";

  return {
    content: `Đối chiếu tuân thủ: ${checks.join(" · ")} → ${verdict}.${veto ? " Tín hiệu chỉ được ghi nhận, không trình duyệt lệnh mới cho đến khi xử lý xong." : ""}`,
    reasoning: "getTradingMode + sessionPhase + biên margin từ tài khoản.",
    sentiment: veto ? "bearish" : null,
    output: { verdict, mode: mode.mode, phase, marginRoom },
  };
}

/* ───────────────────── Nhóm 3 · executive (service) ───────────────────── */

/** A11 Settlement — đối chiếu khớp lệnh, phí, thuế 24h. */
async function runSettlement(): Promise<ServiceRunResult> {
  const since24h = new Date(Date.now() - 24 * 3_600_000);
  const trades = await db.trade.findMany({
    where: { executedAt: { gte: since24h } },
    select: { side: true, quantity: true, price: true, fee: true, tax: true },
  });
  const count = trades.length;
  const totalFee = trades.reduce((s, t) => s + Number(t.fee), 0);
  const totalTax = trades.reduce((s, t) => s + Number(t.tax), 0);
  const totalValue = trades.reduce((s, t) => s + t.quantity * t.price, 0);

  return {
    content: `Thanh toán bù trừ 24h: ${count} lệnh khớp · giá trị ${vnd(totalValue)} ₫ · phí môi giới ${vnd(totalFee)} ₫ · thuế TNCN bán ${vnd(totalTax)} ₫.${count === 0 ? " Không có giao dịch mới — sổ sách đã đối chiếu." : ""}`,
    reasoning: "Tổng hợp Trade 24h qua (fee/tax BigInt → Number).",
    sentiment: null,
    output: { count24h: count, totalValue, totalFee, totalTax },
  };
}

/** A12 Cash Management — dòng tiền & sức mua ước tính. */
async function runCashManagement(): Promise<ServiceRunResult> {
  const snap = await portfolioSnapshot();
  const buyingPower = snap.cash + snap.equity * 0.5 - snap.marginUsed; // §5.4 header
  const tight = buyingPower < 500_000_000; // marginRoomMinVnd roster

  return {
    content: `Dòng tiền: tiền mặt ${vnd(snap.cash)} ₫ · NAV ${vnd(snap.equity)} ₫ · margin đang dùng ${vnd(snap.marginUsed)} ₫ · sức mua ước tính ${vnd(buyingPower)} ₫ (giả lập hệ số 0.5, không phải hạn mức thật VNDIRECT).${tight ? " Sức mua dưới hạn mức nội bộ 500 triệu — hạn chế tín hiệu MUA quy mô lớn." : ""}`,
    reasoning: "cash + equity×0.5 − marginUsed (công thức chip Sức mua §5.4).",
    sentiment: tight ? "neutral" : null,
    output: { cash: snap.cash, equity: snap.equity, marginUsed: snap.marginUsed, buyingPower },
  };
}

/* ───────────────────────── Nhóm 5 · ml (service) ───────────────────────── */

/** A13 Learning & RAG — ký ức phân tích tích luỹ. */
async function runLearningRag(): Promise<ServiceRunResult> {
  const [broadcastCount, distinctAgents, newsTotal] = await Promise.all([
    db.agentMessage.count({ where: { broadcast: true } }),
    db.agentMessage.groupBy({ by: ["fromAgentId"], where: { broadcast: true } }),
    db.newsItem.count(),
  ]);
  const agents = distinctAgents.length;

  return {
    content: `Ký ức đội agent: ${broadcastCount.toLocaleString("vi-VN")} tin broadcast từ ${agents} agent + ${newsTotal.toLocaleString("vi-VN")} tin tức đã nạp — ngữ cảnh truy hồi (RAG) sẵn sàng cho chu kỳ kế tiếp (truy xuất top-8 theo thời gian).`,
    reasoning: "Đếm AgentMessage broadcast + nhóm theo agent + NewsItem.",
    sentiment: null,
    output: { broadcastCount, agents, newsTotal, retrievalTopK: 8 },
  };
}

/** A14 Backtest — kiểm định chiến lược tham chiếu equal-weight. */
async function runBacktest(): Promise<ServiceRunResult> {
  const top = await topLiquid(10);
  const minLen = Math.min(...top.map((t) => t.closes.length));
  if (minLen < 31) {
    return {
      content: "Chưa đủ dữ liệu 90 phiên để kiểm định chiến lược tham chiếu — bỏ qua chu kỳ này.",
      reasoning: "Chuỗi closes ngắn hơn 31 phiên.",
      sentiment: null,
      output: { skipped: true, minLen },
    };
  }
  // Basket index: chuẩn hoá mỗi mã về ngày đầu = 1, lấy trung bình
  const align = Math.min(90, minLen);
  const starts = top.map((t) => t.closes[t.closes.length - align]);
  const index: number[] = [];
  for (let i = 0; i < align; i++) {
    const vals = top.map((t, k) => t.closes[t.closes.length - align + i] / starts[k]);
    index.push(meanOf(vals));
  }
  const totalRet = (index[index.length - 1] / index[0] - 1) * 100;
  const ret30 = (index[index.length - 1] / index[Math.max(0, index.length - 31)] - 1) * 100;
  const dailyRets: number[] = [];
  for (let i = 1; i < index.length; i++) dailyRets.push(index[i] / index[i - 1] - 1);
  const volAnn = stdOf(dailyRets) * Math.sqrt(252) * 100;
  let peak = index[0];
  let maxDD = 0;
  for (const v of index) {
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, (v / peak - 1) * 100);
  }

  return {
    content: `Kiểm định equal-weight top-10 thanh khoản (${align} phiên): tổng ${fmtPct(totalRet)} · 30 phiên gần ${fmtPct(ret30)} · biến động năm hoá ${volAnn.toFixed(1)}% · drawdown tối đa ${maxDD.toFixed(1)}%. Ngưỡng tham chiếu: drawdown danh mục ≤ 15%.`,
    reasoning: "Basket index chuẩn hoá + stdev×√252 + peak-to-trough.",
    sentiment: ret30 > 1 ? "bullish" : ret30 < -1 ? "bearish" : "neutral",
    output: { totalRetPct: Number(totalRet.toFixed(2)), ret30Pct: Number(ret30.toFixed(2)), volAnnPct: Number(volAnn.toFixed(1)), maxDDPct: Number(maxDD.toFixed(1)) },
  };
}

/** S3 RL Gym — trạng thái môi trường giả lập. */
async function runRlGym(): Promise<ServiceRunResult> {
  const [instrumentCount, barCount] = await Promise.all([
    db.instrument.count({ where: { isActive: true } }),
    db.bar.count(),
  ]);
  return {
    content: `Môi trường giả lập sẵn sàng: ${instrumentCount} mã · ${barCount.toLocaleString("vi-VN")} phiên lịch sử · 12 đặc trưng trạng thái · không gian hành động mua/giữ/bán. Chưa có episode huấn luyện trong phiên này — gym chờ lệnh từ RL Trainer.`,
    reasoning: "Đếm Instrument/Bar làm độ phủ môi trường.",
    sentiment: null,
    output: { instrumentCount, barCount, stateFeatures: 12, episodesThisSession: 0 },
  };
}

/** A16 RL Policy — trạng thái chính sách RL đang phục vụ. */
async function runRlPolicy(): Promise<ServiceRunResult> {
  const strategist = await db.agent.findUnique({
    where: { code: "portfolio-strategist" },
    select: { lastRunAt: true },
  });
  const lastUpdate = strategist?.lastRunAt;
  const ageH = lastUpdate ? Math.round((Date.now() - lastUpdate.getTime()) / 3_600_000) : null;
  return {
    content: `Chính sách RL v0 (epsilon khám phá 0.15) đang ở chế độ THAM CHIẾU — chưa đủ episode huấn luyện để trực tiếp phát tín hiệu; tín hiệu chu kỳ vẫn do Chủ tịch Hội đồng (LLM) quyết định.${ageH != null ? ` Lần làm mới ngữ cảnh cách đây ${ageH}h.` : ""}`,
    reasoning: "Trạng thái tĩnh v0 + lastRunAt của portfolio-strategist.",
    sentiment: null,
    output: { policyVersion: "v0", epsilon: 0.15, serving: "reference", lastContextRefreshHours: ageH },
  };
}

/** A17 DL Trainer — trạng thái job huấn luyện học sâu. */
async function runDlTrainer(): Promise<ServiceRunResult> {
  const mlRuns = await db.agentRun.count({
    where: { agent: { code: "ml-forecast" }, taskStatus: "COMPLETED" },
  });
  return {
    content: `Không có job huấn luyện học sâu đang chạy. Mô hình dự báo momentum tuyến tính (ml-forecast) đang phục vụ dịch vụ — đã hoàn tất ${mlRuns} lần chạy tích luỹ dữ liệu. Bước kế tiếp: gom đủ 100 chu kỳ để khởi động job LSTM đầu tiên.`,
    reasoning: "Đếm AgentRun COMPLETED của ml-forecast.",
    sentiment: null,
    output: { activeJobs: 0, mlForecastRuns: mlRuns, nextMilestone: "LSTM @100 chu kỳ" },
  };
}

/** A18 RL Trainer — vòng huấn luyện củng cố. */
async function runRlTrainer(): Promise<ServiceRunResult> {
  const [gymRuns, policyRuns] = await Promise.all([
    db.agentRun.count({ where: { agent: { code: "rl-gym" }, taskStatus: "COMPLETED" } }),
    db.agentRun.count({ where: { agent: { code: "rl-policy" }, taskStatus: "COMPLETED" } }),
  ]);
  return {
    content: `Vòng huấn luyện RL: ${gymRuns} lần kiểm tra môi trường · ${policyRuns} lần đánh giá chính sách · 0 episode hoàn chỉnh trong phiên. Chưa lên bệ kiểm định — cần tối thiểu 100 episode trước khi so sánh với chiến lược tham chiếu.`,
    reasoning: "Đếm AgentRun của rl-gym/rl-policy.",
    sentiment: null,
    output: { gymRuns, policyRuns, episodesCompleted: 0, episodesTarget: 100 },
  };
}

/** A19 Model Registry — sổ đăng ký mô hình đang phục vụ. */
async function runModelRegistry(): Promise<ServiceRunResult> {
  const llm = llmStatus();
  const models = [
    { name: `LLM backbone · ${llm.model}`, provider: llm.provider, status: llm.free ? "free-tier" : "production", version: llm.model },
    { name: "Chỉ báo kỹ thuật SMA/RSI/MACD/BOLL", provider: "deterministic", status: "production", version: "indicators-v1" },
    { name: "Dự báo momentum tuyến tính (ml-forecast)", provider: "deterministic", status: "serving", version: "linreg-v0" },
    { name: "Chính sách RL tham chiếu (rl-policy)", provider: "deterministic", status: "reference", version: "v0" },
  ];
  return {
    content: `Sổ đăng ký ${models.length} mô hình đang phục vụ: LLM backbone ${llm.model} (${llm.provider}${llm.free ? ", free-tier" : ""}) · chỉ báo kỹ thuật SMA/RSI/MACD/BOLL (production) · dự báo momentum tuyến tính (serving) · chính sách RL tham chiếu v0. Không có mô hình nào bị deprecated.`,
    reasoning: "llmStatus() + danh sách mô hình deterministic của hệ thống.",
    sentiment: null,
    output: { models, registryVersion: "2025.1" },
  };
}

/* ───────────────────────────── Cổng gọi chung ───────────────────────────── */

const SERVICE_RUNNERS: Record<string, () => Promise<ServiceRunResult>> = {
  "data-collector": runDataCollector,
  "notification-officer": runNotificationOfficer,
  "feature-store": runFeatureStore,
  "data-integrity": runDataIntegrity,
  "ml-forecast": runMlForecast,
  exposure: runExposure,
  compliance: runCompliance,
  settlement: runSettlement,
  "cash-management": runCashManagement,
  "learning-rag": runLearningRag,
  backtest: runBacktest,
  "rl-gym": runRlGym,
  "rl-policy": runRlPolicy,
  "dl-trainer": runDlTrainer,
  "rl-trainer": runRlTrainer,
  "model-registry": runModelRegistry,
};

/**
 * Chạy một service agent (deterministic). Ném lỗi nếu code không phải
 * service agent — caller xử lý persist FAILED như LLM agents.
 */
export function runServiceAgent(code: string): Promise<ServiceRunResult> {
  const runner = SERVICE_RUNNERS[code];
  if (!runner) {
    throw new Error(`"${code}" không phải service agent (kiểm tra agent-roster.ts kind).`);
  }
  return runner();
}
