"use client";

import { Header } from "@/components/dashboard/header";
import { MarketSummary } from "@/components/dashboard/market-summary";
import { QuotesTable } from "@/components/dashboard/quotes-table";
import { PriceChart } from "@/components/dashboard/price-chart";
import { PortfolioSection } from "@/components/dashboard/portfolio-section";
import { AgentsPanel } from "@/components/dashboard/agents-panel";
import { SignalsFeed } from "@/components/dashboard/signals-feed";
import { RiskAlerts } from "@/components/dashboard/risk-alerts";
import { NewsCard } from "@/components/dashboard/news-card";
import { Footer } from "@/components/dashboard/footer";
import { useRealtimeMarket } from "@/hooks/use-realtime";

export default function Page() {
  // WebSocket realtime (market-engine) — gắn MỘT lần ở cấp trang,
  // trạng thái kết nối chia sẻ qua Zustand store.
  useRealtimeMarket();

  // UI selections live in the Zustand store (blueprint §3) — no prop drilling.
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">
        <h1 className="sr-only">
          The Trader — Bảng điều khiển hệ thống giao dịch đa tác tử VNDIRECT
        </h1>

        <div className="flex flex-col gap-6">
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

          {/* 4. Multi-agent system */}
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
      </main>
      <Footer />
    </div>
  );
}
