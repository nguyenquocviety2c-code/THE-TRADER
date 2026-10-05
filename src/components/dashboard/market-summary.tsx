"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Coins,
  Flame,
  Gauge,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import {
  changeColor,
  formatPct,
  formatPrice,
  formatVndCompact,
  formatVolume,
} from "@/lib/format";
import type { QuotesResponse } from "@/lib/types";

export function MarketSummary() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["quotes"],
    queryFn: () => apiGet<QuotesResponse>("/api/market/quotes"),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <section
        aria-label="Tổng quan thị trường"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="gap-3 py-4">
            <CardContent className="flex flex-col gap-2 px-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-36" />
              <Skeleton className="h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section
        aria-label="Tổng quan thị trường"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Card className="py-4 sm:col-span-2 xl:col-span-4">
          <CardContent className="px-4 text-sm text-down">
            {error?.message ?? "Không tải được tổng quan thị trường."}
          </CardContent>
        </Card>
      </section>
    );
  }

  const s = data.summary;
  const breadthTotal = Math.max(1, s.advancing + s.declining + s.unchanged);
  const upPct = (s.advancing / breadthTotal) * 100;
  const downPct = (s.declining / breadthTotal) * 100;

  return (
    <section
      aria-label="Tổng quan thị trường"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      {/* VN30 proxy */}
      <StatCard
        icon={<Gauge className="size-4" aria-hidden="true" />}
        label="VN30 (chỉ số proxy)"
        value={
          <span className="tabular-nums">
            {s.indexLevel.toLocaleString("vi-VN", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        }
        sub={
          <span className={changeColor(s.avgChangePct)}>
            {s.avgChangePct > 0 ? (
              <ArrowUpRight className="size-3" aria-hidden="true" />
            ) : s.avgChangePct < 0 ? (
              <ArrowDownRight className="size-3" aria-hidden="true" />
            ) : null}
            {formatPct(s.avgChangePct)} · {s.count} mã HOSE
          </span>
        }
      />

      {/* Market breadth */}
      <StatCard
        icon={<BarChart3 className="size-4" aria-hidden="true" />}
        label="Bề rộng thị trường"
        value={
          <span className="tabular-nums">
            <span className="text-up">{s.advancing} tăng</span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-down">{s.declining} giảm</span>
          </span>
        }
        sub={
          <span className="flex flex-col gap-1.5">
            <span className="tabular-nums text-muted-foreground">
              {s.unchanged} mã tham chiếu
            </span>
            <span className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <span className="bg-up" style={{ width: `${upPct}%` }} />
              <span className="bg-down" style={{ width: `${downPct}%` }} />
            </span>
          </span>
        }
      />

      {/* Liquidity */}
      <StatCard
        icon={<Coins className="size-4" aria-hidden="true" />}
        label="Thanh khoản phiên"
        value={
          <span className="tabular-nums">{formatVndCompact(s.totalValue)}</span>
        }
        sub={
          <span className="tabular-nums text-muted-foreground">
            Tổng KL: {formatVolume(s.totalVolume)} cp
          </span>
        }
      />

      {/* Top gainer */}
      <StatCard
        icon={<Flame className="size-4 text-up" aria-hidden="true" />}
        label="Tăng giá nhất"
        value={
          s.topGainer ? (
            <span className="flex items-baseline gap-2">
              <span className="text-lg font-bold tracking-tight">
                {s.topGainer.symbol}
              </span>
              <span className={`tabular-nums text-base font-semibold ${changeColor(s.topGainer.changePct)}`}>
                {formatPct(s.topGainer.changePct)}
              </span>
            </span>
          ) : (
            "—"
          )
        }
        sub={
          s.topGainer ? (
            <span className="tabular-nums text-muted-foreground">
              {formatPrice(s.topGainer.last)} ₫ / cp
            </span>
          ) : null
        }
      />
    </section>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <Card className="gap-3 py-4 transition-shadow hover:shadow-md">
      <CardContent className="flex flex-col gap-1.5 px-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {icon}
          <span>{label}</span>
        </div>
        <div className="text-xl font-semibold tracking-tight sm:text-2xl">
          {value}
        </div>
        {sub ? <div className="text-xs">{sub}</div> : null}
      </CardContent>
    </Card>
  );
}
