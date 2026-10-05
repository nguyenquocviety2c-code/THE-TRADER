"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import { Info, OctagonAlert, ShieldAlert, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { RiskAlertRow } from "@/lib/types";

const SEVERITY: Record<
  string,
  { label: string; className: string; icon: React.ComponentType<{ className?: string }> }
> = {
  CRITICAL: {
    label: "Nghiêm trọng",
    className: "border-down/40 bg-down/10 text-down",
    icon: OctagonAlert,
  },
  WARNING: {
    label: "Cảnh báo",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    icon: TriangleAlert,
  },
  INFO: {
    label: "Thông tin",
    className: "border-border bg-muted text-muted-foreground",
    icon: Info,
  },
};

function fmtMetric(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("vi-VN", { maximumFractionDigits: 2 }) + "%";
}

export function RiskAlerts() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["risk-alerts"],
    queryFn: () => apiGet<{ alerts: RiskAlertRow[] }>("/api/risk/alerts"),
    staleTime: 60_000,
  });

  const alerts = data?.alerts ?? [];
  const criticalCount = alerts.filter((a) => a.severity === "CRITICAL").length;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4 text-muted-foreground" aria-hidden="true" />
          Cảnh báo rủi ro
        </CardTitle>
        <CardDescription>
          {criticalCount > 0
            ? `${criticalCount} cảnh báo nghiêm trọng cần xử lý ngay`
            : "Giám sát giới hạn rủi ro danh mục"}
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-0">
        {isLoading ? (
          <div className="flex flex-col gap-3 pb-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <p className="pb-6 text-sm text-down">
            {error?.message ?? "Không tải được cảnh báo rủi ro."}
          </p>
        ) : alerts.length === 0 ? (
          <p className="pb-6 text-sm text-muted-foreground">
            Không có cảnh báo — danh mục trong giới hạn an toàn.
          </p>
        ) : (
          <ul className="max-h-[32rem] divide-y overflow-y-auto custom-scrollbar">
            {alerts.map((a) => {
              const sev = SEVERITY[a.severity] ?? SEVERITY.INFO;
              const SevIcon = sev.icon;
              return (
                <li key={a.id} className="flex gap-3 py-3.5 pr-1">
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg",
                      a.severity === "CRITICAL"
                        ? "bg-down/10 text-down"
                        : a.severity === "WARNING"
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          : "bg-muted text-muted-foreground"
                    )}
                  >
                    <SevIcon className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={sev.className}>
                        {sev.label}
                      </Badge>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {a.code}
                      </span>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {formatDistanceToNow(new Date(a.createdAt), {
                          addSuffix: true,
                          locale: vi,
                        })}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed">{a.message}</p>
                    {a.metricKey && (
                      <p className="tabular-nums mt-1 text-[11px] text-muted-foreground">
                        <span className="font-mono">{a.metricKey}</span> ={" "}
                        <span
                          className={cn(
                            "font-medium",
                            (a.metricValue ?? 0) > (a.threshold ?? 0)
                              ? "text-down"
                              : "text-foreground"
                          )}
                        >
                          {fmtMetric(a.metricValue)}
                        </span>{" "}
                        (ngưỡng {fmtMetric(a.threshold)})
                      </p>
                    )}
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
