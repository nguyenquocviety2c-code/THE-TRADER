/** Shared API payload types (JSON over the wire — all BigInt already Number). */

export interface QuoteRow {
  symbol: string;
  name: string;
  sector: string;
  market: string;
  last: number;
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
}

export interface AgentsResponse {
  agents: AgentCard[];
  tasks: AgentTaskRow[];
}

export interface AgentMessageRow {
  id: string;
  fromAgent: { code: string; name: string; role: string } | null;
  toAgent: { code: string; name: string } | null;
  broadcast: boolean;
  content: string;
  reasoning: string | null;
  sentiment: string | null;
  createdAt: string;
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
