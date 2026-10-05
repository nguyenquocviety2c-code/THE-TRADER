"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import {
  Brain,
  ChartCandlestick,
  CircleCheck,
  CircleDashed,
  CircleX,
  Loader2,
  Newspaper,
  Play,
  Radio,
  ShieldAlert,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { useRunAgents } from "@/hooks/use-run-agents";
import { cn } from "@/lib/utils";
import type { AgentMessageRow, AgentsResponse } from "@/lib/types";

const ROLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  MARKET_ANALYST: ChartCandlestick,
  NEWS_SENTIMENT: Newspaper,
  RISK_MANAGER: ShieldAlert,
  PORTFOLIO_STRATEGIST: Brain,
  EXECUTION_MANAGER: Zap,
};

const STATUS_DOT: Record<string, { className: string; label: string }> = {
  RUNNING: { className: "bg-up", label: "Đang chạy" },
  IDLE: { className: "bg-muted-foreground", label: "Nhàn rỗi" },
  PAUSED: { className: "bg-amber-500", label: "Tạm dừng" },
  ERROR: { className: "bg-down", label: "Lỗi" },
};

export function AgentsPanel() {
  const runAgents = useRunAgents();

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<AgentsResponse>("/api/agents"),
    staleTime: 30_000,
  });
  const messagesQuery = useQuery({
    queryKey: ["agent-messages"],
    queryFn: () =>
      apiGet<{ messages: AgentMessageRow[] }>("/api/agents/messages"),
    staleTime: 30_000,
  });

  const isRunning = runAgents.isPending;

  const agents = agentsQuery.data?.agents ?? [];
  const tasks = agentsQuery.data?.tasks ?? [];
  const messages = messagesQuery.data?.messages ?? [];

  return (
    <section aria-label="Hệ thống đa tác tử" className="flex flex-col gap-4">
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="size-4 text-muted-foreground" aria-hidden="true" />
            Hệ thống đa tác tử (Multi-Agent)
          </CardTitle>
          <CardDescription>
            5 agent AI phối hợp: phân tích → cảm xúc tin tức → rủi ro → chiến lược →
            thực thi
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Agent cards */}
          {agentsQuery.isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-40 w-full rounded-xl" />
              ))}
            </div>
          ) : agentsQuery.isError ? (
            <p className="text-sm text-down">
              {agentsQuery.error?.message ?? "Không tải được danh sách agent."}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {agents.map((a) => (
                <AgentCardView key={a.id} agent={a} />
              ))}
            </div>
          )}

          <Separator />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              Tổng cộng {agents.length} agent · mô hình nền tảng{" "}
              <span className="font-mono">glm-4.6</span>
            </div>
            <Button
              onClick={() => runAgents.mutate()}
              disabled={isRunning}
              className="min-h-11 gap-2"
              size="lg"
            >
              {isRunning ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Đang phân tích…
                </>
              ) : (
                <>
                  <Play className="size-4" aria-hidden="true" />
                  Chạy chu kỳ phân tích
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tasks + message feed */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="gap-4 lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Nhiệm vụ agent</CardTitle>
            <CardDescription>12 nhiệm vụ gần nhất</CardDescription>
          </CardHeader>
          <CardContent className="pb-0">
            {agentsQuery.isLoading ? (
              <div className="flex flex-col gap-2 pb-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : tasks.length > 0 ? (
              <ul className="max-h-96 divide-y overflow-y-auto custom-scrollbar">
                {tasks.map((t) => (
                  <li key={t.id} className="flex min-h-11 items-center gap-3 py-2.5 pr-2">
                    <TaskStatusIcon status={t.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {t.agentName} ·{" "}
                        {formatDistanceToNow(new Date(t.createdAt), {
                          addSuffix: true,
                          locale: vi,
                        })}
                      </p>
                    </div>
                    <PriorityBadge priority={t.priority} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pb-6 text-sm text-muted-foreground">
                Không có nhiệm vụ nào.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="gap-4 lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-sm">Luồng thảo luận giữa các agent</CardTitle>
            <CardDescription>30 tin nhắn gần nhất (mới nhất trước)</CardDescription>
          </CardHeader>
          <CardContent className="pb-0">
            {messagesQuery.isLoading ? (
              <div className="flex flex-col gap-3 pb-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="size-9 shrink-0 rounded-full" />
                    <div className="flex w-full flex-col gap-1.5">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-2/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : messagesQuery.isError ? (
              <p className="pb-6 text-sm text-down">
                {messagesQuery.error?.message ?? "Không tải được tin nhắn."}
              </p>
            ) : (
              <ul className="max-h-[28rem] divide-y overflow-y-auto custom-scrollbar">
                {isRunning && (
                  <li className="flex items-center gap-3 py-3">
                    <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                    </span>
                    <p className="animate-pulse text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">
                        Chu kỳ đa tác tử
                      </span>{" "}
                      đang chạy: 3 agent phân tích → chiến lược → thực thi…
                    </p>
                  </li>
                )}
                {messages.map((m) => (
                  <MessageItem key={m.id} message={m} />
                ))}
                {messages.length === 0 && !isRunning && (
                  <li className="py-6 text-sm text-muted-foreground">
                    Chưa có tin nhắn. Hãy chạy chu kỳ phân tích đầu tiên.
                  </li>
                )}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function AgentCardView({
  agent,
}: {
  agent: AgentsResponse["agents"][number];
}) {
  const RoleIcon = ROLE_ICONS[agent.role] ?? Brain;
  const dot = STATUS_DOT[agent.status] ?? STATUS_DOT.IDLE;
  const health = Math.max(0, Math.min(100, agent.healthScore));
  const healthColor =
    health >= 80
      ? "[&_[data-slot=progress-indicator]]:bg-up"
      : health >= 60
        ? "[&_[data-slot=progress-indicator]]:bg-amber-500"
        : "[&_[data-slot=progress-indicator]]:bg-down";

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-shadow hover:shadow-md",
        health < 60 && "border-amber-500/50 ring-1 ring-amber-500/30"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <RoleIcon className="size-4.5 text-foreground/80" aria-hidden="true" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">{agent.name}</p>
            <p className="text-[11px] text-muted-foreground">{agent.roleLabel}</p>
          </div>
        </div>
        <span className="flex items-center gap-1.5 pt-1" title={dot.label}>
          <span className="relative flex size-2">
            {agent.status === "RUNNING" && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-60" />
            )}
            <span
              className={cn(
                "relative inline-flex size-2 rounded-full",
                agent.status === "ERROR" && "bg-down",
                dot.className
              )}
              aria-hidden="true"
            />
          </span>
          <span className="text-[10px] text-muted-foreground">{dot.label}</span>
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Sức khỏe</span>
          <span className="tabular-nums font-medium text-foreground">
            {health.toFixed(0)}%
          </span>
        </div>
        <Progress value={health} className={cn("h-1.5", healthColor)} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-mono text-[10px]">
          {agent.model}
        </Badge>
        {agent.pendingTaskCount > 0 && (
          <Badge variant="secondary" className="text-[10px]">
            {agent.pendingTaskCount} nhiệm vụ chờ
          </Badge>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        {agent.lastRunAt
          ? `Chạy cách đây ${formatDistanceToNow(new Date(agent.lastRunAt), {
              locale: vi,
            })}`
          : "Chưa từng chạy"}
      </p>
    </div>
  );
}

function MessageItem({ message }: { message: AgentMessageRow }) {
  const RoleIcon = ROLE_ICONS[message.fromAgent?.role ?? ""] ?? Brain;
  return (
    <li className="flex gap-3 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
        <RoleIcon className="size-4 text-foreground/80" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold">
            {message.fromAgent?.name ?? "Agent"}
          </span>
          {message.sentiment && <SentimentBadge sentiment={message.sentiment} />}
          {message.toAgent ? (
            <span className="text-[11px] text-muted-foreground">
              → {message.toAgent.name}
            </span>
          ) : message.broadcast ? (
            <span className="text-[11px] text-muted-foreground">· phát rộng</span>
          ) : null}
          <span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
            {formatDistanceToNow(new Date(message.createdAt), {
              addSuffix: true,
              locale: vi,
            })}
          </span>
        </div>
        <p className="mt-1 text-sm leading-relaxed">{message.content}</p>
        {message.reasoning && (
          <blockquote className="mt-2 border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted-foreground">
            {message.reasoning}
          </blockquote>
        )}
      </div>
    </li>
  );
}

function SentimentBadge({ sentiment }: { sentiment: string }) {
  if (sentiment === "bullish")
    return (
      <Badge className="bg-up/15 text-up hover:bg-up/15" variant="default">
        Tích cực
      </Badge>
    );
  if (sentiment === "bearish")
    return (
      <Badge className="bg-down/15 text-down hover:bg-down/15" variant="default">
        Tiêu cực
      </Badge>
    );
  return (
    <Badge variant="secondary" className="hover:bg-secondary">
      Trung tính
    </Badge>
  );
}

function TaskStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "RUNNING":
      return <Loader2 className="size-4 shrink-0 animate-spin text-amber-500" aria-label="Đang chạy" />;
    case "COMPLETED":
      return <CircleCheck className="size-4 shrink-0 text-up" aria-label="Hoàn tất" />;
    case "FAILED":
      return <CircleX className="size-4 shrink-0 text-down" aria-label="Thất bại" />;
    default:
      return <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-label="Đang chờ" />;
  }
}

function PriorityBadge({ priority }: { priority: string }) {
  if (priority === "high")
    return (
      <Badge variant="outline" className="border-down/40 text-down">
        Cao
      </Badge>
    );
  if (priority === "medium")
    return (
      <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
        Trung bình
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Thấp
    </Badge>
  );
}
