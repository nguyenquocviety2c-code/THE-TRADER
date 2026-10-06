"use client";

import * as React from "react";
import { MarketSummary } from "@/components/dashboard/market-summary";
import { AssessmentBrief } from "@/components/dashboard/assessment-brief";
import { AgentSystemBrief } from "@/components/dashboard/agent-system-brief";
import { SignalsFeed } from "@/components/dashboard/signals-feed";
import { useUiStore } from "@/lib/store";

/**
 * PHASE3_BLUEPRINT §3.3 + phiên #34 — workspace "Tổng quan" GỌN NHẸ:
 * module cũ dồn 8 section được chia sang 6 workspace nhỏ; ở đây chỉ còn
 * "tin nhanh": stat thị trường → nhận định Bayes → tín hiệu compact +
 * tóm tắt đội agent (link sang workspace đầy đủ).
 *
 * Unmount sạch khi chuyển tab (không giữ listener rác) — realtime socket
 * sống ở cấp page.tsx nên KHÔNG bị đứt khi đổi workspace.
 */
export function OverviewWorkspace() {
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);

  return (
    <div
      role="tabpanel"
      id="workspace-panel-overview"
      aria-labelledby="workspace-tab-overview"
      className="flex flex-col gap-6"
    >
      {/* 1. Market summary stat cards */}
      <MarketSummary />

      {/* 2. Nhận định thị trường — Bộ tổng hợp Bayes (brief) */}
      <AssessmentBrief />

      {/* 3. Tín hiệu compact + tóm tắt hệ thống 23 agents */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <SignalsFeed compact limit={5} onSeeAll={() => setActiveWorkspace("signals")} />
        </div>
        <AgentSystemBrief />
      </div>
    </div>
  );
}
