"use client";

import * as React from "react";
import { Header } from "@/components/dashboard/header";
import { OverviewWorkspace } from "@/components/dashboard/overview-workspace";
import { AgentsWorkspace } from "@/components/dashboard/agents-workspace";
import { Footer } from "@/components/dashboard/footer";
import { useRealtimeMarket } from "@/hooks/use-realtime";
import { useUiStore } from "@/lib/store";

/**
 * PHASE3_BLUEPRINT §3 — App shell (single route `/`):
 * header + workspace nav + workspace switch (Zustand) + sticky footer.
 *
 * WebSocket realtime (market-engine) gắn MỘT lần ở cấp trang — đặt ngoài
 2 workspace component nên đổi tab KHÔNG đứt kết nối realtime.
 */
export default function Page() {
  useRealtimeMarket();

  const activeWorkspace = useUiStore((s) => s.activeWorkspace);
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);

  // ?ws=agents|overview — deep-link đọc MỘT lần khi mount (vẫn route `/`)
  React.useEffect(() => {
    const ws = new URLSearchParams(window.location.search).get("ws");
    if (ws === "agents" || ws === "overview") setActiveWorkspace(ws);
  }, [setActiveWorkspace]);

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">
        <h1 className="sr-only">
          The Trader — Bảng điều khiển hệ thống giao dịch đa tác tử VNDIRECT
        </h1>

        {activeWorkspace === "overview" ? (
          <OverviewWorkspace />
        ) : (
          <AgentsWorkspace />
        )}
      </main>
      <Footer />
    </div>
  );
}
