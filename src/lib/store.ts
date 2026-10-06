"use client";

import { create } from "zustand";

/**
 * Local UI state (TECHNICAL_BLUEPRINT §3 — Zustand store).
 * Server state lives in TanStack Query; this store only holds
 * ephemeral UI selections to avoid prop drilling and duplicated
 * sources of truth.
 */

/** PHASE3_BLUEPRINT §3.1 — workspace tab của app shell (single route `/`). */
export type Workspace = "overview" | "agents";

/** PHASE3_BLUEPRINT §5.1 — chế độ render biểu đồ giá. */
export type ChartMode = "candle" | "line";

interface UiState {
  /** Symbol selected for the price chart / quotes table highlight. */
  selectedSymbol: string;
  setSelectedSymbol: (symbol: string) => void;

  /** Price chart timeframe in trading days (30 / 60 / 90). */
  chartDays: number;
  setChartDays: (days: number) => void;

  /** Active portfolio tab (positions | orders | trades). */
  portfolioTab: string;
  setPortfolioTab: (tab: string) => void;

  /** Quotes table mode: watchlist-only vs full VN30 board. */
  watchlistOnly: boolean;
  setWatchlistOnly: (value: boolean) => void;

  /** PHASE3 B1: workspace đang mở — chuyển bằng nav, không thêm route. */
  activeWorkspace: Workspace;
  setActiveWorkspace: (ws: Workspace) => void;

  /** PHASE3 B3: biểu đồ giá — nến Nhật hay đường polyline. */
  chartMode: ChartMode;
  setChartMode: (mode: ChartMode) => void;

  /** PHASE3 B3: bảng giá — bật/tắt cột mở rộng (trần/sàn/TC/cao/thấp). */
  quotesExpanded: boolean;
  setQuotesExpanded: (value: boolean) => void;

  /** Realtime (WebSocket market-engine) — connection state + tick mới nhất. */
  realtimeConnected: boolean;
  setRealtimeConnected: (value: boolean) => void;
  lastTickAt: number | null;
  setLastTickAt: (ts: number | null) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  selectedSymbol: "VCB",
  setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),

  chartDays: 90,
  setChartDays: (days) => set({ chartDays: days }),

  portfolioTab: "positions",
  setPortfolioTab: (tab) => set({ portfolioTab: tab }),

  watchlistOnly: false,
  setWatchlistOnly: (value) => set({ watchlistOnly: value }),

  activeWorkspace: "overview",
  setActiveWorkspace: (ws) => set({ activeWorkspace: ws }),

  chartMode: "candle",
  setChartMode: (mode) => set({ chartMode: mode }),

  quotesExpanded: false,
  setQuotesExpanded: (value) => set({ quotesExpanded: value }),

  realtimeConnected: false,
  setRealtimeConnected: (value) => set({ realtimeConnected: value }),
  lastTickAt: null,
  setLastTickAt: (ts) => set({ lastTickAt: ts }),
}));
