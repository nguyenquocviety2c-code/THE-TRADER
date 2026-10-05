"use client";

import * as React from "react";
import { Header } from "@/components/dashboard/header";
import { MarketSummary } from "@/components/dashboard/market-summary";
import { QuotesTable } from "@/components/dashboard/quotes-table";
import { PriceChart } from "@/components/dashboard/price-chart";
import { PortfolioSection } from "@/components/dashboard/portfolio-section";
import { AgentsPanel } from "@/components/dashboard/agents-panel";
import { SignalsFeed } from "@/components/dashboard/signals-feed";
import { RiskAlerts } from "@/components/dashboard/risk-alerts";
import { Footer } from "@/components/dashboard/footer";

export default function Page() {
  const [selectedSymbol, setSelectedSymbol] = React.useState("VCB");

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
              <QuotesTable
                selectedSymbol={selectedSymbol}
                onSelect={setSelectedSymbol}
              />
            </div>
            <div className="xl:col-span-3">
              <PriceChart
                symbol={selectedSymbol}
                onSymbolChange={setSelectedSymbol}
              />
            </div>
          </div>

          {/* 3. Portfolio */}
          <PortfolioSection />

          {/* 4. Multi-agent system */}
          <AgentsPanel />

          {/* 5. Signals + risk alerts */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <SignalsFeed />
            </div>
            <RiskAlerts />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
