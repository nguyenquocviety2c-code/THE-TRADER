"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import { ChevronsUpDown } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiGet } from "@/lib/api";
import { useUiStore } from "@/lib/store";
import { changeColor, formatPct, formatPrice, formatVndCompact, formatVolume } from "@/lib/format";
import type { BarPoint, BarsResponse, QuotesResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

const TIMEFRAMES = [30, 60, 90] as const;

export function PriceChart() {
  const symbol = useUiStore((s) => s.selectedSymbol);
  const setSymbol = useUiStore((s) => s.setSelectedSymbol);
  const days = useUiStore((s) => s.chartDays);
  const setDays = useUiStore((s) => s.setChartDays);

  const { data: quotesData } = useQuery({
    queryKey: ["quotes"],
    queryFn: () => apiGet<QuotesResponse>("/api/market/quotes"),
    staleTime: 30_000,
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["bars", symbol, days],
    queryFn: () =>
      apiGet<BarsResponse>(
        `/api/instruments/bars?symbol=${encodeURIComponent(symbol)}&days=${days}`
      ),
    staleTime: 5 * 60_000,
  });

  const bars = React.useMemo(() => data?.bars ?? [], [data]);
  const up = bars.length > 1 && bars[bars.length - 1].close >= bars[0].close;
  const strokeColor = up ? "var(--up)" : "var(--down)";
  const gradientId = `priceGrad-${symbol}`;

  const renderTip = React.useCallback(
    (props: TooltipContentProps) => {
      const { active, payload, label } = props;
      if (!active || !payload?.length || typeof label !== "string") return null;
      const bar: BarPoint | undefined = bars.find((b) => b.date === label);
      if (!bar) return null;
      return (
        <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
          <p className="mb-1.5 font-medium">
            {`${label.slice(8, 10)}/${label.slice(5, 7)}/${label.slice(0, 4)}`}
          </p>
          <p className="tabular-nums">
            Giá đóng cửa:{" "}
            <span className="font-semibold">{formatPrice(bar.close)} ₫</span>
          </p>
          {bar.sma20 != null && (
            <p className="tabular-nums text-muted-foreground">
              SMA20: {formatPrice(bar.sma20)} ₫
            </p>
          )}
          <p className="tabular-nums text-muted-foreground">
            KL: {formatVolume(bar.volume)} cp
          </p>
          <p className="tabular-nums text-muted-foreground">
            GT: {formatVndCompact(bar.value)}
          </p>
        </div>
      );
    },
    [bars]
  );

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base">
          {data ? (
            <>
              <span className="text-lg font-bold tracking-tight">{data.symbol}</span>
              <span className="tabular-nums font-semibold">{formatPrice(data.last)}</span>
              <span
                className={cn("tabular-nums text-sm font-medium", changeColor(data.changePct))}
              >
                {formatPct(data.changePct)}
              </span>
            </>
          ) : (
            <span className="text-lg font-bold tracking-tight">{symbol}</span>
          )}
        </CardTitle>
        <CardDescription className="max-w-[240px] truncate">
          {data?.name ?? "Biểu đồ giá theo phiên"}
        </CardDescription>
        <CardAction className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 min-w-11 gap-1.5 font-mono">
                {symbol}
                <ChevronsUpDown className="size-3.5 opacity-60" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto custom-scrollbar">
              <DropdownMenuLabel>Chọn mã</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(quotesData?.quotes ?? []).map((q) => (
                <DropdownMenuItem
                  key={q.symbol}
                  onSelect={() => setSymbol(q.symbol)}
                  className={cn("gap-2", q.symbol === symbol && "bg-accent")}
                >
                  <span className="w-12 font-mono font-medium">{q.symbol}</span>
                  <span className="tabular-nums ml-auto text-xs text-muted-foreground">
                    {formatPrice(q.last)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tabs
            value={String(days)}
            onValueChange={(v) => setDays(Number(v))}
          >
            <TabsList className="h-9">
              {TIMEFRAMES.map((d) => (
                <TabsTrigger key={d} value={String(d)} className="px-3 text-xs">
                  {d} ngày
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className="pb-0">
        <div className="h-64 sm:h-72 xl:h-80">
          {isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : isError ? (
            <div className="flex h-full items-center justify-center text-sm text-down">
              {error?.message ?? "Không tải được biểu đồ."}
            </div>
          ) : bars.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Không có dữ liệu phiên.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={bars} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={strokeColor} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={strokeColor} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="var(--border)"
                  opacity={0.6}
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`}
                  minTickGap={40}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  dy={6}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tickFormatter={(v: number) => formatPrice(v)}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={72}
                />
                <Tooltip
                  content={renderTip}
                  cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "4 4", strokeWidth: 1 }}
                />
                <Area
                  type="monotone"
                  dataKey="close"
                  name="Giá đóng cửa"
                  stroke={strokeColor}
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  isAnimationActive={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                />
                <Line
                  type="monotone"
                  dataKey="sma20"
                  name="SMA 20"
                  stroke="var(--muted-foreground)"
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
        <p className="px-1 py-3 text-[11px] text-muted-foreground">
          {data ? `${data.days} phiên gần nhất · đường đứt: SMA 20 phiên` : ""}
        </p>
      </CardContent>
    </Card>
  );
}
