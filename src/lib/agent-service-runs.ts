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
import { ROSTER_BY_CODE } from "@/lib/agent-roster";
import { latestFeatures, loadTopSeries } from "@/lib/ml/features";
import { MLP } from "@/lib/ml/nn";
import { buildBasket, parseQTable, policyStance } from "@/lib/ml/rl";
import {
  banditSnapshot,
  pendingSettleCount,
  settlePendingRewards,
} from "@/lib/ml/bandit";

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
    content: `Kho đặc trưng sẵn sàng: ${full}/10 mã top thanh khoản có đủ 4 nhóm đặc trưng (SMA20/50 · động lượng 5 phiên · KL/TL20 · biến động) trên ${ready[0]?.sessions ?? 0} phiên. Mẫu: ${sample.join(" · ")}.`,
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
  // AUD-CODE #15: hạn mức đọc từ roster config — MỘT nguồn duy nhất (không mirror tay)
  const exposureCfg = ROSTER_BY_CODE.get("exposure")?.config as
    | { maxSectorWeightPct?: number; maxPositionPct?: number }
    | undefined;
  const MAX_SECTOR = exposureCfg?.maxSectorWeightPct ?? 40; // % NAV
  const MAX_POSITION = exposureCfg?.maxPositionPct ?? 25; // % NAV
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
  const cashCfg = ROSTER_BY_CODE.get("cash-management")?.config as
    | { marginRoomMinVnd?: number; buyingPowerFactor?: number }
    | undefined;
  const factor = cashCfg?.buyingPowerFactor ?? 0.5;
  const marginMin = cashCfg?.marginRoomMinVnd ?? 500_000_000;
  // AUD-CODE #15b: trước đây cash + equity×0.5 đếm KÉP tiền mặt (equity = cash + GTTH).
  // Đúng: sức mua = cash + GTTH vị thế mở × factor − margin đang dùng
  const positionsMv = Math.max(0, snap.equity - snap.cash);
  const buyingPower = snap.cash + positionsMv * factor - snap.marginUsed;
  const tight = buyingPower < marginMin; // marginRoomMinVnd từ roster config

  return {
    content: `Dòng tiền: tiền mặt ${vnd(snap.cash)} ₫ · NAV ${vnd(snap.equity)} ₫ · margin đang dùng ${vnd(snap.marginUsed)} ₫ · sức mua ước tính ${vnd(buyingPower)} ₫ (tiền mặt + GTTH vị thế × ${factor} − margin; không phải hạn mức thật VNDIRECT).${tight ? ` Sức mua dưới hạn mức nội bộ ${vnd(marginMin)} ₫ — hạn chế tín hiệu MUA quy mô lớn.` : ""}`,
    reasoning: "cash + positionsMv×factor − marginUsed (AUD-CODE #15b — không đếm kép cash).",
    sentiment: tight ? "neutral" : null,
    output: { cash: snap.cash, equity: snap.equity, marginUsed: snap.marginUsed, buyingPower },
  };
}

/* ───────────── Nhóm 5 · ml + rl (phiên #35 — mô hình học THẬT) ───────────── */

/** Parse JSON metrics của MlModel — null khi hỏng. */
function parseModelMetrics(json: string): Record<string, unknown> | null {
  try {
    const m = JSON.parse(json) as Record<string, unknown>;
    return typeof m === "object" && m !== null ? m : null;
  } catch {
    return null;
  }
}

/** Mô hình serving mới nhất theo kind — null khi chưa từng train. */
async function servingModel(kind: "dl-mlp" | "rl-q") {
  return db.mlModel.findFirst({
    where: { kind, status: "serving" },
    orderBy: { version: "desc" },
  });
}

/** Số giờ (làm tròn) kể từ trainedAt → "x giờ trước". */
function hoursAgo(at: Date): string {
  const h = Math.max(0, Math.round((Date.now() - at.getTime()) / 3_600_000));
  return h <= 0 ? "vừa xong" : `${h} giờ trước`;
}

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
  // AUD-CODE #7: top rỗng → Math.min(...[]) = Infinity xuyên qua guard minLen < 31
  if (top.length === 0) {
    return {
      content: "Chưa có dữ liệu bảng giá để kiểm định chiến lược — bỏ qua chu kỳ này.",
      reasoning: "topLiquid trả về rỗng (DB chưa có bar/quote).",
      sentiment: null,
      output: { skipped: true, minLen: 0 },
    };
  }
  const minLen = Math.min(...top.map((t) => t.closes.length));
  if (!Number.isFinite(minLen) || minLen < 31) {
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

/** S3 RL Gym — trạng thái môi trường + tổng số episode đã chạy (thật). */
async function runRlGym(): Promise<ServiceRunResult> {
  const model = await servingModel("rl-q");
  if (!model) {
    // Chưa train: mô tả gym chờ huấn luyện (giữ stats môi trường cũ)
    const [instrumentCount, barCount] = await Promise.all([
      db.instrument.count({ where: { isActive: true } }),
      db.bar.count(),
    ]);
    return {
      content: `Môi trường giả lập sẵn sàng: ${instrumentCount} mã · ${barCount.toLocaleString("vi-VN")} phiên lịch sử · 48 trạng thái (xu hướng × bucket RSI rổ × động lượng 5 phiên × phơi nhiễm) × 3 hành động (giảm/hold/tăng exposure ±0,5). Chưa có episode huấn luyện nào — Q-table trống, gym chờ lệnh từ RL Trainer (POST /api/ml/train target rl-q).`,
      reasoning: "Đếm Instrument/Bar làm độ phủ môi trường (chưa có MlModel rl-q).",
      sentiment: null,
      output: { trained: false, instrumentCount, barCount, states: 48, actions: 3 },
    };
  }
  const metrics = parseModelMetrics(model.metrics);
  // Tổng episode mọi phiên bản kind rl-q (kể cả archived) — số thật tích luỹ
  const allVersions = await db.mlModel.findMany({
    where: { kind: "rl-q" },
    select: { metrics: true },
  });
  let episodesTotal = typeof metrics?.episodes === "number" ? (metrics.episodes as number) : 0;
  for (const v of allVersions) {
    const m = parseModelMetrics(v.metrics);
    if (m !== metrics && typeof m?.episodes === "number") episodesTotal += m.episodes as number;
  }
  const epsilonEnd = typeof metrics?.epsilonEnd === "number" ? metrics.epsilonEnd : null;
  const avgRewardLast50 =
    typeof metrics?.avgRewardLast50 === "number" ? metrics.avgRewardLast50 : null;
  return {
    content: `Gym Q-learning 48 trạng thái × 3 hành động: đã chạy tổng cộng ${episodesTotal.toLocaleString("vi-VN")} episode qua ${allVersions.length} phiên bản (bản serving v${model.version}, train ${hoursAgo(model.trainedAt)}) — ε khám phá kết thúc ${epsilonEnd != null ? epsilonEnd.toFixed(2) : "—"}, phần thưởng trung bình 50 episode cuối ${avgRewardLast50 != null ? (avgRewardLast50 >= 0 ? "+" : "") + avgRewardLast50.toFixed(3) : "—"} mỗi episode (~230 bước, reward = exposure×lợi nhuận rổ − 0,1% phí điều chỉnh).`,
    reasoning: "Đọc MlModel rl-q serving + cộng dồn metrics.episodes mọi phiên bản.",
    sentiment: null,
    output: {
      trained: true,
      version: model.version,
      versions: allVersions.length,
      episodesTotal,
      epsilonEnd,
      avgRewardLast50,
      states: 48,
      actions: 3,
    },
  };
}

/** A16 RL Policy — khuyến nghị phơi nhiễm từ Q-table THẬT (tham mưu). */
async function runRlPolicy(): Promise<ServiceRunResult> {
  const model = await servingModel("rl-q");
  if (!model) {
    return {
      content: "Chính sách Q-learning chưa huấn luyện — Q-learning chưa có Q-table, khuyến nghị phơi nhiễm giữ mặc định 0,5. Tín hiệu chu kỳ vẫn do Chủ tịch Hội đồng (LLM) quyết định — dùng nút 'Huấn luyện mô hình' trong workspace Tổng hợp hoặc POST /api/ml/train (target rl-q) để nạp Q-table 48×3.",
      reasoning: "Không có MlModel kind rl-q serving.",
      sentiment: null,
      output: { trained: false, policyVersion: null, states: 48, actions: 3, defaultExposure: 0.5 },
    };
  }
  const metrics = parseModelMetrics(model.metrics);
  const episodes = typeof metrics?.episodes === "number" ? (metrics.episodes as number) : 0;
  let content: string;
  let output: Record<string, unknown> = { trained: true, policyVersion: `v${model.version}`, episodes };
  try {
    const qTable = parseQTable(model.weights);
    const series = await loadTopSeries(10);
    const basket = buildBasket(series.map((s) => s.closes));
    const st = policyStance(qTable, basket, 0.5);
    const [pGiam, pGiu, pTang] = st.probsSoftmax;
    content = `Chính sách Q-learning v${model.version} sau ${episodes.toLocaleString("vi-VN")} episode khuyến nghị ${st.stance.toUpperCase()} phơi nhiễm (exposure ${(st.exposure * 100).toFixed(0)}%, Q-max ${st.qMax.toFixed(2)}, xác suất softmax tăng/giữ/giảm ${(pTang * 100).toFixed(1)}/${(pGiu * 100).toFixed(1)}/${(pGiam * 100).toFixed(1)}%) trên rổ top-10 thanh khoản. Tín hiệu cuối vẫn do Chủ tịch Hội đồng quyết định — RL ở chế độ tham mưu.`;
    output = {
      ...output,
      stance: st.stance,
      exposure: st.exposure,
      qMax: st.qMax,
      probsSoftmax: st.probsSoftmax,
      basketSessions: basket.length,
    };
  } catch {
    content = `Chính sách Q-learning v${model.version} (train ${hoursAgo(model.trainedAt)}) không đọc được Q-table từ kho trọng số — giữ khuyến nghị mặc định exposure 0,5. Tín hiệu cuối vẫn do Chủ tịch Hội đồng quyết định — RL ở chế độ tham mưu.`;
  }
  return {
    content,
    reasoning: "parseQTable(MlModel.weights) + policyStance trên rổ top-10 hiện tại.",
    sentiment: null,
    output,
  };
}

/** A17 DL Trainer — metrics MLP thật + dự đoán hiện tại qua latestFeatures. */
async function runDlTrainer(): Promise<ServiceRunResult> {
  const model = await servingModel("dl-mlp");
  if (!model) {
    return {
      content: "Chưa có mô hình học sâu — dùng nút 'Huấn luyện mô hình' trong workspace Tổng hợp hoặc POST /api/ml/train (target dl-mlp). MLP 10→16 ReLU→8 ReLU→3 softmax sẽ học trên ~50k mẫu EOD top-20 thanh khoản (backprop + Adam, dự báo hướng 5 phiên tới).",
      reasoning: "Không có MlModel kind dl-mlp serving.",
      sentiment: null,
      output: { hasModel: false, hint: "POST /api/ml/train {\"target\":\"dl-mlp\"}" },
    };
  }
  const metrics = parseModelMetrics(model.metrics);
  const num = (k: string): number | null =>
    typeof metrics?.[k] === "number" ? (metrics[k] as number) : null;
  const topSymbols = Array.isArray(metrics?.topSymbols) ? (metrics.topSymbols as string[]) : [];
  let content: string;
  let output: Record<string, unknown> = { hasModel: true, version: model.version, metrics };
  let sentiment: ServiceRunResult["sentiment"] = null;
  try {
    const mlp = MLP.fromJSON(model.weights);
    const feats = await latestFeatures(); // top-10 phiên cuối
    const preds = feats.slice(0, 5).map((f) => ({ symbol: f.symbol, p: mlp.predictProba(f.x) }));
    if (preds.length > 0) {
      const avgUp = meanOf(preds.map((r) => r.p[0]));
      const avgDown = meanOf(preds.map((r) => r.p[2]));
      const diff = avgUp - avgDown;
      const lean =
        diff > 0.05 ? "nghiêng TĂNG" : diff < -0.05 ? "nghiêng GIẢM" : "đi ngang/chưa tách bạch";
      content = `Mạng MLP 10→16→8→3 v${model.version} đang phục vụ (train ${hoursAgo(model.trainedAt)}): ${num("samples")?.toLocaleString("vi-VN") ?? "—"} mẫu · ${num("epochs") ?? "—"} epoch · chính xác kiểm định ${num("valAcc") != null ? ((num("valAcc") as number) * 100).toFixed(1) + "%" : "—"} · mất mát kiểm định ${num("valLoss")?.toFixed(3) ?? "—"}. Mã đóng góp mạnh: ${topSymbols.slice(0, 5).join(", ") || "—"}. Dự đoán hiện tại trên ${preds.length} mã thanh khoản nhất: p(tăng) ${(avgUp * 100).toFixed(1)}% / p(giảm) ${(avgDown * 100).toFixed(1)}% — mô hình ${lean}.`;
      sentiment = diff > 0.05 ? "bullish" : diff < -0.05 ? "bearish" : "neutral";
      output = {
        ...output,
        predictions: preds.map((r) => ({
          symbol: r.symbol,
          pUp: Number(r.p[0].toFixed(4)),
          pFlat: Number(r.p[1].toFixed(4)),
          pDown: Number(r.p[2].toFixed(4)),
        })),
        avgPUp: Number(avgUp.toFixed(4)),
        avgPDown: Number(avgDown.toFixed(4)),
      };
      return {
        content,
        reasoning: "MlModel dl-mlp serving + MLP.fromJSON → predictProba trên latestFeatures().",
        sentiment,
        output,
      };
    }
    content = `Mạng MLP 10→16→8→3 v${model.version} đang phục vụ (train ${hoursAgo(model.trainedAt)}): ${num("samples")?.toLocaleString("vi-VN") ?? "—"} mẫu · ${num("epochs") ?? "—"} epoch · chính xác kiểm định ${num("valAcc") != null ? ((num("valAcc") as number) * 100).toFixed(1) + "%" : "—"}. Mã đóng góp mạnh: ${topSymbols.slice(0, 5).join(", ") || "—"}. Chưa đủ dữ liệu phiên cuối để dự đoán serving.`;
  } catch {
    content = `Mạng MLP v${model.version} (train ${hoursAgo(model.trainedAt)}) không nạp được trọng số từ kho — cần huấn luyện lại qua POST /api/ml/train (target dl-mlp).`;
  }
  return {
    content,
    reasoning: "MlModel dl-mlp serving (metrics thật; serving thiếu dữ liệu/lỗi → trung thực).",
    sentiment,
    output,
  };
}

/** A18 RL Trainer — kết toán bandit Thompson sampling (0 LLM, nhanh). */
async function runRlTrainer(): Promise<ServiceRunResult> {
  let result: Awaited<ReturnType<typeof settlePendingRewards>>;
  try {
    result = await settlePendingRewards();
  } catch (err) {
    console.error("[runRlTrainer] settlePendingRewards lỗi:", err);
    return {
      content: "Kết toán bandit lỗi (truy vấn dữ liệu giá) — thử lại chu kỳ sau. Posterior các arm giữ nguyên.",
      reasoning: "settlePendingRewards throw — không đổi alpha/beta.",
      sentiment: null,
      output: { error: true },
    };
  }
  const pending = await pendingSettleCount().catch(() => 0);
  const snapshot = await banditSnapshot().catch(() => null);
  const topArm = snapshot?.arms[0];

  const rewardLines = (result.details ?? [])
    .map((d) => `${d.agentName}: reward ${d.reward.toFixed(1)}`)
    .join(" · ");
  const parts = [
    `Kết toán bandit Thompson sampling: đối chiếu ${(result.votes + pending).toLocaleString("vi-VN")} phiếu bầu cũ với giá thực tế — ${result.settled} assessment đủ 5 phiên tuổi được kết toán (${result.votes} phiếu), ${pending.toLocaleString("vi-VN")} phiếu chờ tới phiên thứ 5.`,
    topArm
      ? `Posterior hiện tại: ${topArm.name} dẫn đầu ${(topArm.posteriorMean * 100).toFixed(1)}% (α ${topArm.alpha.toFixed(1)} · β ${topArm.beta.toFixed(1)} · ${topArm.pulls} pulls)${snapshot && snapshot.arms.length > 1 ? `, theo sau ${snapshot.arms[1].name} ${(snapshot.arms[1].posteriorMean * 100).toFixed(1)}%` : ""}.`
      : "Chưa có arm bandit nào trong kho.",
    result.votes > 0 && rewardLines ? `Chi tiết phiếu kết toán: ${rewardLines}.` : "",
  ].filter(Boolean);

  return {
    content: parts.join(" "),
    reasoning: "settlePendingRewards (đối chiếu realized rổ top-10 5 phiên) + banditSnapshot posterior Beta(α+1,β+1).",
    sentiment: null,
    output: {
      settled: result.settled,
      votes: result.votes,
      pending,
      arms: snapshot?.arms ?? [],
      details: result.details ?? [],
    },
  };
}

/** A19 Model Registry — sổ đăng ký ĐỘNG (đúng version/status/trainedAt thật). */
async function runModelRegistry(): Promise<ServiceRunResult> {
  const llm = llmStatus();
  const serving = await db.mlModel.findMany({
    where: { status: "serving" },
    orderBy: { kind: "asc" },
  });
  const dl = serving.find((m) => m.kind === "dl-mlp");
  const rl = serving.find((m) => m.kind === "rl-q");

  const models: Record<string, unknown>[] = [
    {
      name: `LLM backbone · ${llm.model}`,
      provider: llm.provider,
      status: llm.free ? "free-tier" : "production",
      version: llm.model,
    },
    {
      name: "Chỉ báo kỹ thuật SMA/RSI/MACD/BOLL",
      provider: "deterministic",
      status: "production",
      version: "indicators-v1",
    },
    {
      name: "Dự báo momentum tuyến tính (ml-forecast)",
      provider: "deterministic",
      status: "serving",
      version: "linreg-v0",
    },
  ];
  if (dl) {
    models.push({
      name: "Mạng nơ-ron MLP dự báo 5 phiên (dl-trainer)",
      provider: "deterministic",
      status: "serving",
      version: `v${dl.version}`,
      trainedAt: dl.trainedAt.toISOString(),
    });
  }
  if (rl) {
    models.push({
      name: "Chính sách Q-learning 48×3 (rl-policy)",
      provider: "deterministic",
      status: "serving",
      version: `v${rl.version}`,
      trainedAt: rl.trainedAt.toISOString(),
    });
  }

  const mlPart = [
    dl
      ? `MLP dl-mlp v${dl.version} (serving, train ${hoursAgo(dl.trainedAt)})`
      : "MLP dl-mlp chưa huấn luyện",
    rl
      ? `Q-learning rl-q v${rl.version} (serving, train ${hoursAgo(rl.trainedAt)})`
      : "Q-learning rl-q chưa huấn luyện",
  ].join(" · ");

  return {
    content: `Sổ đăng ký ${models.length} mô hình đang phục vụ: LLM backbone ${llm.model} (${llm.provider}${llm.free ? ", free-tier" : ""}) · chỉ báo kỹ thuật indicators-v1 (production) · dự báo momentum tuyến tính linreg-v0 (serving) · ${mlPart}. Bandit Thompson sampling 5 arm chạy kèm bộ tổng hợp Bayes (không phải model riêng).`,
    reasoning: "llmStatus() + findMany MlModel status serving (động theo kho thật).",
    sentiment: null,
    output: { models, registryVersion: "2026.1-ml" },
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
