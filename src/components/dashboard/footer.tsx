"use client";

import * as React from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import { Database, ExternalLink, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * Sticky footer (blueprint §3): data-source status + last cache update +
 * disclaimer. The market data currently comes from the internal seed
 * generator (S1 — DATA_SOURCES.md §3.1), i.e. simulated / paper trading.
 */
export function Footer() {
  const queryClient = useQueryClient();
  const isFetching = useIsFetching() > 0;

  // Latest cache write timestamp — reactive via a cache subscription
  // (recomputes whenever any query settles) + a 15s refresh tick.
  const [lastUpdatedMs, setLastUpdatedMs] = React.useState<number | null>(null);
  React.useEffect(() => {
    const compute = () => {
      const queries = queryClient.getQueryCache().getAll();
      const latest = queries.reduce<number>((max, q) => {
        const ts = q.state.dataUpdatedAt;
        return ts > max ? ts : max;
      }, 0);
      setLastUpdatedMs((prev) =>
        latest > 0 && latest !== prev ? latest : prev
      );
    };
    compute();
    const unsubscribe = queryClient.getQueryCache().subscribe(compute);
    const timer = setInterval(compute, 15_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [queryClient]);

  // Relative label ("x giây trước"), refreshed periodically.
  const [relativeLabel, setRelativeLabel] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!lastUpdatedMs) return;
    const update = () =>
      setRelativeLabel(
        formatDistanceToNow(new Date(lastUpdatedMs), {
          addSuffix: true,
          locale: vi,
        })
      );
    update();
    const timer = setInterval(update, 15_000);
    return () => clearInterval(timer);
  }, [lastUpdatedMs]);

  const lastUpdated = lastUpdatedMs ? new Date(lastUpdatedMs) : null;

  return (
    <footer className="mt-auto border-t bg-background/60">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col items-center justify-between gap-2 px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground sm:flex-row sm:px-6 sm:text-left">
        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
          <Badge
            variant="outline"
            className="gap-1.5 px-2 py-0.5 text-[10px] text-muted-foreground"
            title="Nguồn dữ liệu hiện tại: bộ sinh dữ liệu nội bộ (seed) — giao dịch giấy"
          >
            <Database className="size-3" aria-hidden="true" />
            Nguồn dữ liệu: mô phỏng (paper)
          </Badge>
          {lastUpdated && relativeLabel && (
            <span className="tabular-nums whitespace-nowrap">
              Cập nhật lần cuối {relativeLabel}
              {isFetching ? " · đang làm mới…" : ""}
            </span>
          )}
          <span className="hidden sm:inline" aria-hidden="true">
            ·
          </span>
          <span className="hidden sm:inline">
            The Trader — Hệ thống giao dịch đa tác tử · VNDIRECT · Chỉ dùng cho
            mục đích minh họa
          </span>
        </div>
        <nav aria-label="Liên kết chân trang" className="flex items-center gap-4">
          <a
            href="https://www.vndirect.com.vn"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1 transition-colors hover:text-foreground sm:min-h-0"
          >
            <ExternalLink className="size-3" aria-hidden="true" />
            VNDIRECT
          </a>
          <a
            href="#"
            className="inline-flex min-h-11 items-center gap-1 transition-colors hover:text-foreground sm:min-h-0"
            onClick={(e) => e.preventDefault()}
          >
            <FileText className="size-3" aria-hidden="true" />
            Tài liệu hệ thống
          </a>
        </nav>
      </div>
    </footer>
  );
}
