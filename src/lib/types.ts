/** Shared API payload types (JSON over the wire — all BigInt already Number). */

export interface QuoteRow {
  symbol: string;
  name: string;
  sector: string;
  market: string;
  last: number;
  /** PHASE3 B3 §5.2 — cao/thấp phiên hiện tại (cột mở rộng bảng giá). */
  high: number | null;
  low: number | null;
  change: number;
  changePct: number;
  volume: number;
  bidPrice: number | null;
  askPrice: number | null;
  bidVolume: number | null;
  askVolume: number | null;
  refPrice: number | null;
  ceilingPrice: number | null;
  floorPrice: number | null;
  tradedAt: string;
}

export interface MarketSummary {
  indexLevel: number;
  avgChangePct: number;
  advancing: number;
  declining: number;
  unchanged: number;
  count: number;
  totalVolume: number;
  totalValue: number;
  topGainer: { symbol: string; changePct: number; last: number } | null;
  topLoser: { symbol: string; changePct: number; last: number } | null;
}

export interface QuotesResponse {
  quotes: QuoteRow[];
  summary: MarketSummary;
  /** S4 stale marking — có từ Giai đoạn 2 */
  meta?: { mode: string; asOf: string };
}

export interface BarPoint {
  date: string; // yyyy-MM-dd
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  value: number;
  sma20: number | null;
}

export interface BarsResponse {
  symbol: string;
  name: string;
  days: number;
  last: number;
  change: number;
  changePct: number;
  bars: BarPoint[];
}

export interface PortfolioPosition {
  symbol: string;
  name: string;
  sector: string;
  quantity: number;
  avgPrice: number;
  last: number;
  refPrice: number | null;
  changePct: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl: number;
}

export interface PortfolioResponse {
  account: {
    broker: string;
    accountNumber: string;
    accountType: string;
    cashBalance: number;
    equity: number;
    marginUsed: number;
    currency: string;
    status: string;
  };
  positions: PortfolioPosition[];
  totals: {
    totalMarketValue: number;
    totalCostBasis: number;
    totalUnrealizedPnl: number;
    totalUnrealizedPnlPct: number;
    totalRealizedPnl: number;
    totalEquity: number;
    dayChangePct: number;
  };
}

export interface OrderRow {
  id: string;
  symbol: string;
  name: string;
  side: "BUY" | "SELL";
  type: string;
  quantity: number;
  price: number | null;
  filledQuantity: number;
  avgFillPrice: number | null;
  status: string;
  fee: number;
  note: string | null;
  createdAt: string;
  submittedAt: string | null;
  filledAt: string | null;
}

export interface TradeRow {
  id: string;
  symbol: string;
  name: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  value: number;
  fee: number;
  tax: number;
  executedAt: string;
}

export interface AgentTaskRow {
  id: string;
  agentCode: string;
  agentName: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  createdAt: string;
}

export interface AgentCard {
  id: string;
  code: string;
  name: string;
  role: string;
  roleLabel: string;
  description: string;
  model: string;
  status: string;
  healthScore: number;
  lastRunAt: string | null;
  config: Record<string, unknown> | null;
  pendingTaskCount: number;
  lastRun: {
    taskStatus: string;
    startedAt: string;
    durationMs: number | null;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  } | null;
  /** PHASE3 B2 §4.2 — stats chi phí/độ tin cậy mỗi agent. */
  stats: AgentStats;
}

/** PHASE3_BLUEPRINT §4.2 — thống kê vận hành mỗi agent (GET /api/agents). */
export interface AgentStats {
  runCount: number;
  /** COMPLETED / tổng run (0 khi chưa có run nào). */
  successRate: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  lastError: string | null;
  /** Số tin chat 1-1 (broadcast=false) của agent. */
  chatCount: number;
}

/** Tổng chi phí AI cả đội (footer chip + workspace Đội Agent). */
export interface AgentsTotals {
  runCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
}

/** Provider LLM đang chạy — nguồn duy nhất cho chip/tooltip model trên UI. */
export interface LlmInfo {
  provider: "zai" | "opencode-zen";
  model: string;
  modelLabel: string;
  free: boolean;
  priceInMtOk: number;
  priceOutMtOk: number;
  runsOutsideSandbox: boolean;
}

export interface AgentsResponse {
  agents: AgentCard[];
  tasks: AgentTaskRow[];
  /** PHASE3 B2: tổng hợp chi phí AI toàn đội (§5.5 — chip chi phí AI). */
  totals: AgentsTotals;
  /** Provider LLM runtime (Opencode Zen space-bunny-free khi có key, GLM-4.6 trong sandbox). */
  llm: LlmInfo;
}

export interface AgentMessageRow {
  id: string;
  fromAgent: { code: string; name: string; role: string } | null;
  toAgent: { code: string; name: string } | null;
  broadcast: boolean;
  /** PHASE3 B2 §4.1 — AGENT | USER (chat 1-1 lưu từAgentId = agent sở hữu thread). */
  direction: "AGENT" | "USER";
  content: string;
  reasoning: string | null;
  sentiment: string | null;
  createdAt: string;
}

/** PHASE3_BLUEPRINT §4.2 — dòng AgentRun trong hồ sơ chi tiết agent. */
export interface AgentRunRow {
  id: string;
  taskStatus: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: string | null;
}

/** Tin chat 1-1 trong thread của agent (broadcast=false). */
export interface AgentChatMessageRow {
  id: string;
  direction: "AGENT" | "USER";
  content: string;
  createdAt: string;
}

/** PHASE3_BLUEPRINT §4.2 — GET /api/agents/[id] hồ sơ chi tiết. */
export interface AgentDetailResponse {
  agent: AgentCard;
  runs: AgentRunRow[];
  tasks: AgentTaskRow[];
  /** Thread chat 1-1 (broadcast=false, asc). */
  chat: AgentChatMessageRow[];
  /** 20 tin broadcast gần nhất (desc). */
  broadcastFeed: AgentMessageRow[];
  /** Tín hiệu mở của agent này (status ACTIVE). */
  signals: SignalRow[];
}

/** PHASE3_BLUEPRINT §4.3 — POST /api/agents/[id]/run (chạy riêng 1 agent). */
export interface AgentSingleRunResponse {
  agent: { id: string; code: string; name: string };
  message: {
    id: string;
    content: string;
    reasoning: string | null;
    sentiment: string | null;
  } | null;
  run: {
    id: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    durationMs: number | null;
    taskStatus: string;
  };
}

/** PHASE3_BLUEPRINT §4.4 — POST /api/agents/[id]/chat (chat trực tiếp). */
export interface AgentChatResponse {
  userMessage: AgentChatMessageRow;
  reply: AgentChatMessageRow | null;
  run: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    durationMs: number | null;
  } | null;
  threadLength: number;
  /** Lỗi SDK → 200 kèm reply null + error VN (tin user đã lưu không mất). */
  error?: string;
}

/** PHASE3_BLUEPRINT §4.5 — POST /api/signals/[id]/decision. */
export interface SignalDecisionResponse {
  signal: SignalRow;
  /** Chỉ có khi APPROVE thành công. */
  order: {
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    price: number | null;
    status: string;
  } | null;
}

export interface AgentRunResult {
  id: string;
  taskStatus: string;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: string | null;
}

/** Response of the full multi-agent cycle — POST /api/agents/run (blueprint §5.2). */
export interface RunCycleResponse {
  runId: string | null;
  messages: AgentMessageRow[];
  signals: {
    id: string;
    symbol: string;
    direction: "BUY" | "SELL" | "HOLD";
    score: number;
    confidence: string;
    rationale: string;
    targetPrice: number | null;
    stopLoss: number | null;
    takeProfit: number | null;
    expiresAt: string | null;
  }[];
  order: {
    id: string;
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    price: number | null;
    status: string;
  } | null;
  failures: string[];
  durationMs: number;
}

/** Back-compat alias (older single-agent response shape). */
export type RunAgentResponse = RunCycleResponse;

export interface WatchlistResponse {
  watchlist: {
    id: string;
    name: string;
    isDefault: boolean;
    count: number;
    quotes: QuoteRow[];
  };
}

export interface SignalRow {
  id: string;
  symbol: string;
  name: string;
  direction: "BUY" | "SELL" | "HOLD";
  confidence: string;
  score: number;
  rationale: string;
  targetPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  agentName: string | null;
  agentCode: string | null;
  actedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** PHASE3 B2 §4.1 — ACTIVE | ACTED | REJECTED | EXPIRED. */
  status: string;
  rejectedAt: string | null;
  rejectNote: string | null;
}

export interface RiskAlertRow {
  id: string;
  severity: string;
  code: string;
  message: string;
  metricKey: string | null;
  metricValue: number | null;
  threshold: number | null;
  createdAt: string;
}

/* ═══════════════ Giai đoạn 2 (S4/S5/S6 + realtime) ═══════════════ */

export interface NewsItemRow {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  category: string | null;
  publishedAt: string;
  fetchedAt: string;
}

export interface NewsResponse {
  items: NewsItemRow[];
  meta: {
    total: number;
    mode: string;
    lastSuccessAt: string | null;
    stale: boolean;
    ageMinutes: number | null;
    providers: string[];
  };
}

export interface NewsIngestResponse {
  added: number;
  updated: number;
  total: number;
  mode: string;
  feeds: { name: string; ok: boolean; items: number; error?: string }[];
  ingestedAt: string;
}

export interface FlowsItem {
  symbol: string;
  netValue: number;
}

export interface FlowsResponse {
  mode: string;
  asOf: string;
  totalNet: number;
  totalBuy: number;
  totalSell: number;
  topNet: FlowsItem[];
  topSell: FlowsItem[];
  note: string;
}

export interface SourceStatusUI {
  key: string;
  label: string;
  mode: string;
  stale: boolean;
  ageMinutes: number | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  providers: string[];
  updatedAt: string;
}

export interface SystemStatusResponse {
  sources: SourceStatusUI[];
  trading: {
    live: boolean;
    configured: boolean;
    mode: string;
    label: string;
  };
  market: {
    phase: string;
    phaseLabel: string;
    inSession: boolean;
    strictSession: boolean;
  };
  counts: {
    news: number;
    signals: number;
    orders: number;
    agentMessages: number;
  };
  escalatedAlerts: number;
  serverTime: string;
}

export interface WatchlistToggleResponse {
  symbol: string;
  inWatchlist: boolean;
  count: number;
}
