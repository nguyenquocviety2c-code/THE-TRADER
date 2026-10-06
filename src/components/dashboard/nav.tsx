"use client";

import { Bot, LayoutDashboard } from "lucide-react";
import { useUiStore, type Workspace } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * PHASE3_BLUEPRINT §3.2 — thanh tab workspace, render bên trong Header
 * (hàng dưới thanh logo). Chuyển workspace bằng Zustand — KHÔNG reload
 * trang, KHÔNG thêm route (bất biến single-route `/`).
 *
 * Mobile (<sm): 2 tab chia đôi hàng, touch target ≥ 44px.
 */

const TABS: { id: Workspace; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "overview", label: "Tổng quan", icon: LayoutDashboard },
  { id: "agents", label: "Đội Agent", icon: Bot },
];

export function WorkspaceNav() {
  const active = useUiStore((s) => s.activeWorkspace);
  const setActive = useUiStore((s) => s.setActiveWorkspace);
  const realtimeConnected = useUiStore((s) => s.realtimeConnected);

  return (
    <nav
      aria-label="Chuyển vùng làm việc"
      className="border-t border-border/60 bg-background/60"
    >
      <div
        role="tablist"
        aria-label="Vùng làm việc"
        className="mx-auto flex w-full max-w-[1440px] items-stretch gap-1 px-2 pt-1.5 sm:gap-2 sm:px-6"
      >
        {TABS.map((tab) => {
          const selected = active === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`workspace-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`workspace-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(e) => {
                // Đ.phím mũi tên trái/phải chuyển tab (chuẩn WAI-ARIA tabs)
                if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  const idx = TABS.findIndex((t) => t.id === tab.id);
                  const next = (idx + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
                  setActive(TABS[next].id);
                  document.getElementById(`workspace-tab-${TABS[next].id}`)?.focus();
                }
              }}
              className={cn(
                // Mobile: 2 tab chia đôi, touch target ≥44px; desktop: nút dạng tab
                "relative flex min-h-11 flex-1 items-center justify-center gap-2 rounded-t-lg border-b-2 px-3 text-sm font-medium transition-colors sm:min-h-10 sm:flex-none sm:px-4",
                selected
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span>{tab.label}</span>
              {/* Badge chấm realtime khi workspace Đội Agent mở & engine đang nối */}
              {tab.id === "agents" && realtimeConnected && (
                <span
                  className="relative flex size-2 shrink-0"
                  title="market-engine đang phát realtime"
                >
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-up" />
                </span>
              )}
              {selected && (
                <span className="sr-only">(đang mở)</span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
