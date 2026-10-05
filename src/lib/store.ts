"use client";

import { create } from "zustand";

/**
 * Local UI state (TECHNICAL_BLUEPRINT §3 — Zustand store).
 * Server state lives in TanStack Query; this store only holds
 * ephemeral UI selections to avoid prop drilling and duplicated
 * sources of truth.
 */
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

  realtimeConnected: false,
  setRealtimeConnected: (value) => set({ realtimeConnected: value }),
  lastTickAt: null,
  setLastTickAt: (ts) => set({ lastTickAt: ts }),
}));
