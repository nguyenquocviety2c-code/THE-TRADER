"use client";

import * as React from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { Loader2, Moon, Play, RefreshCw, Sun, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiGet } from "@/lib/api";
import { useRunAgents } from "@/hooks/use-run-agents";
import { cn } from "@/lib/utils";
import { formatVnd, isMarketOpen, vnClock, vnDate } from "@/lib/format";
import type { PortfolioResponse } from "@/lib/types";

const emptySubscribe = () => () => {};

/** true only after hydration (avoids theme icon flash + hydration mismatch) */
function useMounted(): boolean {
  return React.useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

/** Live wall clock, updating every second (null during SSR). */
function useNow(): Date | null {
  const seconds = React.useSyncExternalStore(
    (onChange) => {
      const timer = setInterval(onChange, 1000);
      return () => clearInterval(timer);
    },
    () => Math.floor(Date.now() / 1000),
    () => 0
  );
  return React.useMemo(
    () => (seconds > 0 ? new Date(seconds * 1000) : null),
    [seconds]
  );
}

export function Header() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const now = useNow();
  const queryClient = useQueryClient();
  const runAgents = useRunAgents();

  const { data: portfolio } = useQuery({
    queryKey: ["portfolio"],
    queryFn: () => apiGet<PortfolioResponse>("/api/portfolio"),
    staleTime: 60_000,
  });

  const isRefreshing = useIsFetching() > 0;

  const open = now ? isMarketOpen(now) : false;

  async function handleRefresh() {
    try {
      await queryClient.invalidateQueries();
      toast.success("Đã làm mới dữ liệu mới nhất");
    } catch {
      toast.error("Không thể làm mới dữ liệu. Vui lòng thử lại.");
    }
  }

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div
            className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <TrendingUp className="size-5" />
          </div>
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-tight">The Trader</p>
            <p className="text-xs text-muted-foreground">
              Multi-Agent Trading · VNDIRECT
            </p>
          </div>
        </div>

        {/* Right cluster */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Clock + market state */}
          <div className="hidden flex-col items-end leading-tight sm:flex">
            <span className="tabular-nums text-sm font-medium" suppressHydrationWarning>
              {now ? vnClock(now) : "--:--:--"}
            </span>
            <span className="text-[11px] text-muted-foreground" suppressHydrationWarning>
              {now ? vnDate(now) : "—"}
            </span>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "gap-1.5 px-2.5 py-1 text-xs",
              open
                ? "border-up/40 text-up"
                : "text-muted-foreground"
            )}
          >
            <span className="relative flex size-2">
              <span
                className={cn(
                  "absolute inline-flex h-full w-full rounded-full opacity-60",
                  open ? "animate-ping bg-up" : "bg-muted-foreground"
                )}
              />
              <span
                className={cn(
                  "relative inline-flex size-2 rounded-full",
                  open ? "bg-up" : "bg-muted-foreground"
                )}
              />
            </span>
            {open ? "Mở cửa" : "Đóng cửa"}
          </Badge>

          {/* Account chip */}
          <div className="hidden items-center gap-2 rounded-lg border px-3 py-1.5 md:flex">
            <div className="leading-tight">
              <p className="font-mono text-[11px] text-muted-foreground">
                VNDIRECT · {portfolio?.account.accountNumber ?? "—"}
              </p>
              <p className="tabular-nums text-sm font-semibold">
                {portfolio ? formatVnd(portfolio.account.equity) : "— ₫"}
              </p>
            </div>
          </div>

          {/* Run agents (blueprint §3 — header action) */}
          <Button
            onClick={() => runAgents.mutate()}
            disabled={runAgents.isPending}
            className="min-h-9 gap-2"
            size="sm"
          >
            {runAgents.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                <span className="hidden sm:inline">Đang phân tích…</span>
                <span className="sm:hidden">Phân tích…</span>
              </>
            ) : (
              <>
                <Play className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">Chạy agent</span>
                <span className="sm:hidden">Agent</span>
              </>
            )}
          </Button>

          {/* Theme toggle */}
          <Button
            variant="outline"
            size="icon"
            aria-label={mounted && theme === "dark" ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="size-9"
          >
            {mounted && theme === "dark" ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>

          {/* Refresh */}
          <Button
            variant="outline"
            size="icon"
            aria-label="Làm mới dữ liệu"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="size-9"
          >
            <RefreshCw className={cn("size-4", isRefreshing && "animate-spin")} />
          </Button>
        </div>
      </div>
    </header>
  );
}
