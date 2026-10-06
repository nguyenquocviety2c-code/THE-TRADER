"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api";
import { formatVolume } from "@/lib/format";
import { useRunAgents } from "@/hooks/use-run-agents";
import { RateLimitError, useSingleAgentRun } from "@/hooks/use-agent-actions";
import { AgentRosterCard } from "@/components/dashboard/agent-roster-card";
import { AgentDetailPanel } from "@/components/dashboard/agent-detail-panel";
import type { AgentsResponse } from "@/lib/types";

/**
 * PHASE3_BLUEPRINT §4.7 — workspace "Đội Agent" (B2 thay placeholder B1):
 * roster 5 card + panel chi tiết/chat. Mobile stack dọc, desktop 2 cột xl:.
 * Mutation "chạy riêng" sống ở đây để nút roster + panel đồng bộ trạng thái.
 */
export function AgentsWorkspace() {
  const runAgents = useRunAgents();
  const singleRun = useSingleAgentRun();

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => apiGet<AgentsResponse>("/api/agents"),
    staleTime: 30_000,
  });

  // Agent đang mở panel chi tiết (local state — không cần Zustand).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // retryAfterSeconds theo agent id — set khi chạy riêng dính 429;
  // workspace là chủ duy nhất của đồng hồ đếm ngược (tick giảm mỗi giây).
  const [retryAfter, setRetryAfter] = useState<Record<string, number>>({});

  function handleRun(agentId: string) {
    // Chạy riêng từ roster → luôn mở panel chi tiết (auto refetch qua invalidate).
    setSelectedId(agentId);
    singleRun.mutate(agentId, {
      onError: (err) => {
        if (err instanceof RateLimitError) {
          setRetryAfter((r) => ({ ...r, [agentId]: err.retryAfterSeconds }));
        }
      },
    });
  }

  // Tick đồng hồ đếm ngược chung cho roster cards + panel (setState trong
  // callback timer — subscription external system, an toàn re-render).
  const hasRetry = Object.values(retryAfter).some((v) => v > 0);
  useEffect(() => {
    if (!hasRetry) return;
    const timer = setInterval(() => {
      setRetryAfter((r) => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [id, v] of Object.entries(r)) {
          const nv = Math.max(0, v - 1);
          if (nv !== v) changed = true;
          if (nv > 0) next[id] = nv;
        }
        return changed ? next : r;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [hasRetry]);

  const agents = agentsQuery.data?.agents ?? [];
  const totals = agentsQuery.data?.totals;
  const totalTokens =
    totals ? totals.totalTokensIn + totals.totalTokensOut : null;

  return (
    <div
      role="tabpanel"
      id="workspace-panel-agents"
      aria-labelledby="workspace-tab-agents"
      className="flex flex-col gap-6"
    >
      {/* Header workspace: mô tả đội + tổng chi phí AI + chạy chu kỳ đầy đủ */}
      <Card>
        <CardContent className="flex flex-col gap-4 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted"
              aria-hidden="true"
            >
              <Bot className="size-5 text-foreground/80" />
            </span>
            <div className="leading-tight">
              <p className="text-base font-semibold">Đội Agent</p>
              <p className="text-xs text-muted-foreground">
                5 agent AI{" "}
                <span className="font-mono" title={agentsQuery.data?.llm?.modelLabel}>
                  {agentsQuery.data?.llm?.model ?? "…"}
                </span>
                : phân tích → cảm xúc → rủi ro → chiến lược → thực thi
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 lg:justify-end">
            <p className="tabular-nums text-xs text-muted-foreground">
              {agents.length} agent
              {totals
                ? ` · $${totals.totalCostUsd.toFixed(2)} chi phí AI lũy kế · ${formatVolume(totalTokens ?? 0)} tokens`
                : ""}
            </p>
            <Button
              onClick={() => runAgents.mutate()}
              disabled={runAgents.isPending}
              className="min-h-11 gap-2"
              aria-label="Chạy chu kỳ đầy đủ 5 agent"
            >
              {runAgents.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Đang phân tích…
                </>
              ) : (
                <>
                  <Play className="size-4" aria-hidden="true" />
                  Chạy chu kỳ đầy đủ
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Body: roster (trái) + panel chi tiết/chat (phải) */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <div className="grid grid-cols-1 gap-3 self-start sm:grid-cols-2 xl:col-span-2 xl:grid-cols-1">
          {agentsQuery.isLoading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-48 w-full rounded-xl" />
            ))
          ) : agentsQuery.isError ? (
            <p className="text-sm text-down sm:col-span-2 xl:col-span-1">
              {agentsQuery.error?.message ?? "Không tải được danh sách agent."}
            </p>
          ) : (
            agents.map((a) => (
              <AgentRosterCard
                key={a.id}
                agent={a}
                selected={selectedId === a.id}
                onSelect={() =>
                  setSelectedId((cur) => (cur === a.id ? cur : a.id))
                }
                onRun={() => handleRun(a.id)}
                runPending={
                  singleRun.isPending && singleRun.variables === a.id
                }
                retryAfterSeconds={retryAfter[a.id] ?? null}
              />
            ))
          )}
        </div>

        <div className="xl:col-span-3">
          {selectedId ? (
            <AgentDetailPanel
              key={selectedId}
              agentId={selectedId}
              onClose={() => setSelectedId(null)}
              onRun={() => handleRun(selectedId)}
              runPending={
                singleRun.isPending && singleRun.variables === selectedId
              }
              retryAfterSeconds={retryAfter[selectedId] ?? null}
            />
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-8 text-center">
              <Bot
                className="size-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="max-w-sm text-sm text-muted-foreground">
                Chọn một agent để xem hồ sơ, chạy riêng và chat trực tiếp
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
