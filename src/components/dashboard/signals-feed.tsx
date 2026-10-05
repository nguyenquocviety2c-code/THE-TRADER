"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import {
  ArrowRight,
  Loader2,
  Minus,
  Radar,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet, apiPost } from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SignalRow } from "@/lib/types";

const DIRECTION: Record<
  string,
  { label: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  BUY: {
    label: "Mua",
    className: "bg-up/15 text-up hover:bg-up/15",
    icon: TrendingUp,
  },
  SELL: {
    label: "Bán",
    className: "bg-down/15 text-down hover:bg-down/15",
    icon: TrendingDown,
  },
  HOLD: {
    label: "Giữ",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    icon: Minus,
  },
};

const CONFIDENCE: Record<string, { label: string; className: string }> = {
  HIGH: { label: "Tin cậy cao", className: "border-up/40 text-up" },
  MEDIUM: { label: "Tin cậy vừa", className: "border-amber-500/40 text-amber-600 dark:text-amber-400" },
  LOW: { label: "Tin cậy thấp", className: "text-muted-foreground" },
};

export function SignalsFeed() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["signals"],
    queryFn: () => apiGet<{ signals: SignalRow[] }>("/api/signals"),
    staleTime: 60_000,
  });

  const convertMutation = useMutation({
    mutationFn: (id: string) =>
      apiPost<{ order: { symbol: string; side: string; quantity: number; price: number } }>(
        `/api/signals/${id}/convert`
      ),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["signals"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast.success("Đã tạo lệnh chờ khớp", {
        description: `${res.order.side === "BUY" ? "MUA" : "BÁN"} ${res.order.quantity} cp ${res.order.symbol} @ ${formatPrice(res.order.price)} ₫`,
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không chuyển được tín hiệu thành lệnh.");
    },
  });

  const signals = data?.signals ?? [];

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Radar className="size-4 text-muted-foreground" aria-hidden="true" />
          Tín hiệu giao dịch
        </CardTitle>
        <CardDescription>Khuyến nghị mới nhất từ các agent</CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        {isLoading ? (
          <div className="flex flex-col gap-3 pb-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <p className="pb-6 text-sm text-down">
            {error?.message ?? "Không tải được tín hiệu."}
          </p>
        ) : signals.length === 0 ? (
          <p className="pb-6 text-sm text-muted-foreground">Chưa có tín hiệu nào.</p>
        ) : (
          <ul className="max-h-[32rem] divide-y overflow-y-auto custom-scrollbar">
            {signals.map((s) => {
              const dir = DIRECTION[s.direction] ?? DIRECTION.HOLD;
              const DirIcon = dir.icon;
              const conf = CONFIDENCE[s.confidence] ?? CONFIDENCE.MEDIUM;
              const convertible = s.direction !== "HOLD" && !s.actedAt;
              return (
                <li key={s.id} className="flex flex-col gap-2 py-3.5 pr-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={cn("gap-1", dir.className)}>
                      <DirIcon className="size-3" aria-hidden="true" />
                      {dir.label}
                    </Badge>
                    <span className="text-sm font-bold tracking-tight">{s.symbol}</span>
                    <span className="max-w-[220px] truncate text-xs text-muted-foreground">
                      {s.name}
                    </span>
                    {convertible && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-auto h-8 gap-1.5 px-2.5 text-xs"
                        disabled={convertMutation.isPending}
                        onClick={() => convertMutation.mutate(s.id)}
                      >
                        {convertMutation.isPending &&
                        convertMutation.variables === s.id ? (
                          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                        ) : (
                          <ArrowRight className="size-3" aria-hidden="true" />
                        )}
                        Chuyển lệnh
                      </Button>
                    )}
                    {s.actedAt && (
                      <Badge variant="secondary" className="ml-auto text-[10px]">
                        Đã chuyển lệnh
                      </Badge>
                    )}
                  </div>

                  <p className="text-sm leading-relaxed">{s.rationale}</p>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                    <div className="flex min-w-32 flex-1 items-center gap-2 sm:max-w-48">
                      <span className="whitespace-nowrap text-muted-foreground">
                        Điểm {s.score.toFixed(0)}/100
                      </span>
                      <Progress
                        value={s.score}
                        className="h-1.5 [&_[data-slot=progress-indicator]]:bg-primary"
                      />
                    </div>
                    <Badge variant="outline" className={cn("text-[10px]", conf.className)}>
                      {conf.label}
                    </Badge>
                  </div>

                  <div className="tabular-nums flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    {s.targetPrice != null && (
                      <span>
                        Mục tiêu:{" "}
                        <span className="font-medium text-foreground">
                          {formatPrice(s.targetPrice)} ₫
                        </span>
                      </span>
                    )}
                    {s.stopLoss != null && (
                      <span>
                        Cắt lỗ:{" "}
                        <span className="font-medium text-down">
                          {formatPrice(s.stopLoss)} ₫
                        </span>
                      </span>
                    )}
                    {s.takeProfit != null && (
                      <span>
                        Chốt lời:{" "}
                        <span className="font-medium text-up">
                          {formatPrice(s.takeProfit)} ₫
                        </span>
                      </span>
                    )}
                    <span className="ml-auto">
                      {s.agentName ?? "Agent"} ·{" "}
                      {formatDistanceToNow(new Date(s.createdAt), {
                        addSuffix: true,
                        locale: vi,
                      })}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
