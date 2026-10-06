"use client";

/**
 * PHASE3_BLUEPRINT §3.3 — workspace "Tổng quan" (nâng cấp B3).
 * Toàn bộ section dashboard cũ của page.tsx dồn về đây; page.tsx chỉ
 * còn vai trò AppShell (header + nav + workspace switch + footer).
 *
 * Unmount sạch khi chuyển tab (không giữ listener rác) — realtime socket
 * sống ở cấp page.tsx nên KHÔNG bị đứt khi đổi workspace.
 */
import { MarketSummary } from "@/components/dashboard/market-summary";
import { QuotesTable } from "@/components/dashboard/quotes-table";
import { PriceChart } from "@/components/dashboard/price-chart";
import { PortfolioSection } from "@/components/dashboard/portfolio-section";
import { AgentsPanel } from "@/components/dashboard/agents-panel";
import { SignalsFeed } from "@/components/dashboard/signals-feed";
import { RiskAlerts } from "@/components/dashboard/risk-alerts";
import { NewsCard } from "@/components/dashboard/news-card";

export function OverviewWorkspace() {
  return (
    <div
      role="tabpanel"
      id="workspace-panel-overview"
      aria-labelledby="workspace-tab-overview"
      className="flex flex-col gap-6"
    >
      {/* 1. Market summary stat cards */}
      <MarketSummary />

      {/* 2. Watchlist + price chart */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <div className="xl:col-span-2">
          <QuotesTable />
        </div>
        <div className="xl:col-span-3">
          <PriceChart />
        </div>
      </div>

      {/* 3. Portfolio */}
      <PortfolioSection />

      {/* 4. Multi-agent system (feed broadcast + phê duyệt/từ chối — B2) */}
      <AgentsPanel />

      {/* 5. Signals + risk alerts + news */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <SignalsFeed />
        </div>
        <div className="flex flex-col gap-6">
          <RiskAlerts />
          <NewsCard />
        </div>
      </div>
    </div>
  );
}
