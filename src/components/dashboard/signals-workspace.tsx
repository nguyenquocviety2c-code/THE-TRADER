"use client";

import { AgentsPanel } from "@/components/dashboard/agents-panel";
import { RiskAlerts } from "@/components/dashboard/risk-alerts";
import { SignalsFeed } from "@/components/dashboard/signals-feed";

/**
 * Phiên #34 — workspace "Tín hiệu" (vận hành tín hiệu): tách khỏi module
 * Tổng quan cũ. SignalsFeed cột trái + cột phải RiskAlerts + AgentsPanel
 * (feed broadcast + phê duyệt/từ chối tín hiệu strategist).
 */
export function SignalsWorkspace() {
  return (
    <div
      role="tabpanel"
      id="workspace-panel-signals"
      aria-labelledby="workspace-tab-signals"
      className="flex flex-col gap-6"
    >
      <h2 className="sr-only">
        Tín hiệu — khuyến nghị, cảnh báo rủi ro &amp; vận hành phê duyệt
      </h2>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <SignalsFeed />
        </div>
        <div className="flex flex-col gap-6">
          <RiskAlerts />
          {/* AgentsPanel: feed broadcast + phê duyệt tín hiệu (phiên #47 —
              nút chạy chu kỳ đã dời về nút "Chạy agent" duy nhất trên Header) */}
          <AgentsPanel />
        </div>
      </div>
    </div>
  );
}
