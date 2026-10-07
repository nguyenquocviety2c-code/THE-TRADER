"use client";

import { Fragment, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Award, Bot, Loader2, Play, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiGet } from "@/lib/api";
import { formatVolume } from "@/lib/format";
import { useRunAgents } from "@/hooks/use-run-agents";
import { RateLimitError, useSingleAgentRun } from "@/hooks/use-agent-actions";
import { AgentRosterCard } from "@/components/dashboard/agent-roster-card";
import { AgentDetailPanel } from "@/components/dashboard/agent-detail-panel";
import { CoverageMatrix } from "@/components/dashboard/coverage-matrix";
import { cn } from "@/lib/utils";
import type { AgentCard, AgentsResponse } from "@/lib/types";
import type { ScorecardRow } from "@/lib/research/scorecard";

/** Mở rộng 23 agents — thứ tự 5 nhóm hiển thị trong roster (agent-roster.ts backend). */
const GROUP_ORDER = ["research", "control", "executive", "platform", "ml"] as const;

/** Mô tả ngắn mỗi nhóm dưới header section. */
const GROUP_DESCRIPTIONS: Record<string, string> = {
  research: "Phân tích chuyên sâu cấp tín hiệu đầu vào",
  control: "Quyền VETO — rủi ro, phơi nhiễm, tuân thủ",
  executive: "Tổng hợp, ra tín hiệu, thực thi",
  platform: "Thu thập & kiểm định dữ liệu",
  ml: "Backtest, dự báo, giả lập RL",
};

interface AgentGroupSection {
  key: string;
  label: string;
  description: string;
  agents: AgentCard[];
}

/** GET /api/research/scorecard — shape hợp đồng với route B8. */
interface ScorecardResponse {
  agents: ScorecardRow[];
  generatedAt: string;
}

/** Chia agents theo nhóm theo GROUP_ORDER — nhóm lạ gom vào section "Khác" cuối danh sách. */
function groupAgentsBySection(agents: AgentCard[]): AgentGroupSection[] {
  const sections: AgentGroupSection[] = GROUP_ORDER.map((key) => ({
    key,
    label: "",
    description: GROUP_DESCRIPTIONS[key] ?? "",
    agents: [],
  }));
  const fallback: AgentGroupSection = {
    key: "other",
    label: "Nhóm khác",
    description: "Agent chưa phân nhóm",
    agents: [],
  };
  for (const a of agents) {
    const section = sections.find((s) => s.key === a.group);
    if (section) {
      // groupLabel do API trả về (đồng nhất trong nhóm) — lấy của agent đầu tiên.
      if (!section.label) section.label = a.groupLabel;
      section.agents.push(a);
    } else {
      if (fallback.agents.length === 0) fallback.label = a.groupLabel || "Nhóm khác";
      fallback.agents.push(a);
    }
  }
  return [...sections, fallback].filter((s) => s.agents.length > 0);
}

/**
 * PHASE3_BLUEPRINT §4.7 — workspace "Đội Agent" (B2 thay placeholder B1):
 * roster 23 card chia 5 nhóm + panel chi tiết/chat. Mobile stack dọc, desktop 2 cột xl:.
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
  // Phiên #45 — bộ lọc nhóm agent: mặc định "all" (hiển thị toàn bộ 23);
  // chọn 1 nhóm để rút ngắn danh sách roster quá dài theo yêu cầu user.
  const [groupFilter, setGroupFilter] = useState<string>("all");
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
  const sections = groupAgentsBySection(agents);
  // Phiên #45 — roster lọc theo nhóm đang chọn ("all" = mọi nhóm).
  const visibleSections =
    groupFilter === "all"
      ? sections
      : sections.filter((s) => s.key === groupFilter);
  // Scorecard + ma trận độ phủ chỉ gắn bối cảnh nhóm research — ẩn khi lọc nhóm khác.
  const showResearchExtras = groupFilter === "all" || groupFilter === "research";
  const totals = agentsQuery.data?.totals;
  const totalTokens =
    totals ? totals.totalTokensIn + totals.totalTokensOut : null;
  // Số agent động (… khi đang tải — tránh nhảy số trên header).
  const agentCount = agentsQuery.isLoading ? null : agents.length;

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
                <span className="tabular-nums">{agentCount ?? "…"}</span> agents ·{" "}
                {GROUP_ORDER.length} nhóm: nền tảng dữ liệu → hội đồng nghiên cứu → ủy
                ban kiểm soát (VETO) → chủ tịch → thực thi
                <span className="mx-1" aria-hidden="true">·</span>
                <span className="font-mono" title={agentsQuery.data?.llm?.modelLabel}>
                  {agentsQuery.data?.llm?.model ?? "…"}
                </span>
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
              aria-label={`Chạy chu kỳ đầy đủ${agentCount ? ` ${agentCount} agent` : ""}`}
            >
              {runAgents.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Đang phân tích…
                </>
              ) : (
                <>
                  <Play className="size-4" aria-hidden="true" />
                  Chạy chu kỳ đầy đủ{agentCount ? ` (${agentCount} agents)` : ""}
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Body: roster (trái, cuộn dọc khi dài ở desktop) + panel chi tiết/chat (phải) */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <div
          className="flex flex-col gap-4 self-start xl:col-span-2 xl:max-h-[calc(100vh-13rem)] xl:overflow-y-auto xl:pr-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
        >
          {/* Phiên #45 — nút chọn nhóm agent: rút ngắn roster 23 agents
           * (yêu cầu user — hiển thị luôn tất cả hơi dài). Pill toggle, touch ≥44px. */}
          {!agentsQuery.isLoading && !agentsQuery.isError && sections.length > 0 && (
            <div
              role="group"
              aria-label="Chọn nhóm agent hiển thị"
              className="flex flex-wrap gap-2"
            >
              <GroupFilterButton
                active={groupFilter === "all"}
                onClick={() => setGroupFilter("all")}
                label="Tất cả"
                count={agents.length}
              />
              {sections.map((s) => (
                <GroupFilterButton
                  key={s.key}
                  active={groupFilter === s.key}
                  onClick={() => setGroupFilter(s.key)}
                  label={s.label}
                  count={s.agents.length}
                />
              ))}
            </div>
          )}

          {agentsQuery.isLoading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-48 w-full rounded-xl" />
              ))}
            </div>
          ) : agentsQuery.isError ? (
            <p className="text-sm text-down">
              {agentsQuery.error?.message ?? "Không tải được danh sách agent."}
            </p>
          ) : (
            visibleSections.map((section, i) => (
              <Fragment key={section.key}>
                <section
                  aria-label={section.label}
                  className={cn("flex flex-col gap-3", i > 0 && "border-t border-border pt-4")}
                >
                  {/* Header nhóm — dính lên khi cuộn vùng roster ở desktop */}
                  <div className="flex flex-col gap-0.5 xl:sticky xl:top-0 xl:z-10 xl:bg-background/95 xl:py-1 xl:backdrop-blur">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {section.label}
                      </h3>
                      <Badge
                        variant="secondary"
                        className="px-1.5 py-0 text-[10px] tabular-nums"
                      >
                        {section.agents.length} agent
                      </Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground/80">
                      {section.description}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
                    {section.agents.map((a) => (
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
                    ))}
                  </div>
                </section>
                {/* B8 — Bảng điểm Hội đồng Nghiên cứu: NGAY DƯỚI section nhóm
                    research (chốt user §0.3 — blueprint §3.6/Bước 8) */}
                {/* B14 — Ma trận độ phủ thị trường: ĐẶT SAU scorecard
                    (§3.7/Bước 14 — cùng tab Đội Agent theo chốt user §0.3) */}
                {section.key === "research" && showResearchExtras && (
                  <>
                    <ResearchScorecard />
                    <CoverageMatrix />
                  </>
                )}
              </Fragment>
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

/* ═══════════════ Phiên #45 — nút lọc nhóm agent (pill toggle) ═══════════════ */

function GroupFilterButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 sm:min-h-9",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border/70 bg-background text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground"
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 py-0 text-[10px] tabular-nums",
          active
            ? "bg-primary-foreground/15 text-primary-foreground"
            : "bg-muted text-muted-foreground"
        )}
      >
        {count}
      </span>
    </button>
  );
}

/* ═══════════════ B8 — Bảng điểm Hội đồng Nghiên cứu (§3.6 blueprint) ═══════════════ */

const nf0 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const nf2 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "62,5%" — nhập tỷ lệ 0..1 → ×100 (vi-VN, dấu phẩy thập phân). */
function pct1(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${nf1.format(n * 100)}%`;
}

/** Health 0..100: ≥70 xanh lá · <50 đỏ · còn lại muted. */
function healthTone(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "text-muted-foreground";
  if (n >= 70) return "text-emerald-600 dark:text-emerald-400";
  if (n < 50) return "text-rose-600 dark:text-rose-400";
  return "text-foreground";
}

/**
 * Card "Bảng điểm Hội đồng Nghiên cứu" — đặt ngay dưới section nhóm research
 * (chốt user §0.3). 6 cử tri: hit-rate 5 phiên · Brier · đóng góp posterior
 * |Δlog-odds| · streak · posterior bandit · health. pulls < 5 → hàng mờ +
 * badge "chưa đủ dữ liệu" (trung thực, không bịa). TanStack Query
 * "/api/research/scorecard" + skeleton + error state + retry.
 */
function ResearchScorecard() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["research-scorecard"],
    queryFn: () => apiGet<ScorecardResponse>("/api/research/scorecard"),
    staleTime: 30_000,
  });
  const rows = data?.agents ?? [];

  return (
    <Card className="gap-4" aria-labelledby="research-scorecard-heading">
      <CardHeader>
        <CardTitle
          id="research-scorecard-heading"
          className="flex items-center gap-2 text-base"
        >
          <Award className="size-4 text-muted-foreground" aria-hidden="true" />
          Bảng điểm Hội đồng Nghiên cứu
        </CardTitle>
        <CardDescription>
          6 cử tri · hit-rate 5 phiên · Brier · đóng góp posterior — sắp theo
          hit-rate giảm dần
        </CardDescription>
        {data?.generatedAt && (
          <CardAction>
            <span className="text-[11px] text-muted-foreground">
              Cập nhật {new Date(data.generatedAt).toLocaleString("vi-VN", {
                timeZone: "Asia/Ho_Chi_Minh",
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pb-0">
        {isLoading ? (
          <ScorecardSkeleton />
        ) : isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-down/40 bg-down/10 p-4 text-sm text-down"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <p className="min-w-40 flex-1 leading-relaxed">
              Không tải được bảng điểm Hội đồng Nghiên cứu
              {error?.message ? ` — ${error.message}` : "."}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => void refetch()}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Thử lại
            </Button>
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto custom-scrollbar rounded-lg border">
            {/* table-fixed mobile: hàng gộp 1 cell không đẩy bảng rộng hơn container */}
            <Table className="table-fixed sm:table-auto">
              <TableHeader>
                <TableRow className="hidden sm:table-row">
                  <TableHead className="text-xs">Agent</TableHead>
                  <TableHead className="text-xs">Pulls</TableHead>
                  <TableHead className="text-xs">Hit-rate 5 phiên</TableHead>
                  <TableHead className="text-xs">Brier</TableHead>
                  <TableHead className="hidden text-xs md:table-cell">
                    Đóng góp |Δlog-odds|
                  </TableHead>
                  <TableHead className="hidden text-xs sm:table-cell">Streak</TableHead>
                  <TableHead className="text-xs">Posterior bandit</TableHead>
                  <TableHead className="hidden text-xs lg:table-cell">Health</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <ScorecardRowView key={row.code} row={row} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="pb-4 text-[11px] leading-relaxed text-muted-foreground">
          Hit-rate = tỉ lệ phiếu đúng hướng giá thực tế sau 5 phiên (BanditEvent
          đã kết toán) · Brier thấp = tự tin chuẩn · đóng góp posterior = trung
          bình |Δlog-odds| phiếu trong 30 lần tổng hợp gần nhất.
        </p>
      </CardContent>
    </Card>
  );
}

function ScorecardRowView({ row }: { row: ScorecardRow }) {
  const meta = `${row.code}${row.gen1 ? ` · ${row.gen1}` : ""} · ${nf1.format(row.wins)} wins`;
  const hitTone =
    row.hitRate == null
      ? "text-muted-foreground"
      : row.hitRate >= 0.5
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-rose-600 dark:text-rose-400";

  return (
    <TableRow className={cn(!row.enoughData && "opacity-60")}>
      {/* Mobile — 1 hàng gộp (không tràn cột ở 390px) */}
      <TableCell colSpan={8} className="sm:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-xs font-semibold" title={row.name}>
                {row.name}
              </span>
              {!row.enoughData && (
                <Badge
                  variant="outline"
                  className="px-1 py-0 text-[9px] text-muted-foreground"
                >
                  chưa đủ dữ liệu
                </Badge>
              )}
            </span>
            <span className="truncate text-[10px] text-muted-foreground" title={meta}>
              {meta}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-2">
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {nf0.format(row.pulls)} pulls
            </span>
            <span className={cn("tabular-nums text-xs font-semibold", hitTone)}>
              {pct1(row.hitRate)}
            </span>
            <span className="tabular-nums text-xs">{pct1(row.posteriorMean)}</span>
          </span>
        </div>
      </TableCell>

      {/* Desktop — 8 cột đầy đủ */}
      <TableCell className="hidden sm:table-cell">
        <div className="flex flex-col leading-tight">
          <span className="flex items-center gap-1.5">
            <span className="max-w-32 truncate text-xs font-semibold" title={row.name}>
              {row.name}
            </span>
            {!row.enoughData && (
              <Badge
                variant="outline"
                className="px-1 py-0 text-[9px] text-muted-foreground"
                title="Chưa đủ 5 lần kết toán để so sánh đáng tin cậy"
              >
                chưa đủ dữ liệu
              </Badge>
            )}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground" title={meta}>
            {row.gen1 ? `${row.gen1} · ` : ""}
            {row.code}
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs sm:table-cell">
        {nf0.format(row.pulls)}
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span className={cn("tabular-nums text-xs font-semibold", hitTone)}>
          {pct1(row.hitRate)}
        </span>
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {row.brier == null ? "—" : nf2.format(row.brier)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground md:table-cell">
        {row.posteriorContribution == null ? "—" : nf2.format(row.posteriorContribution)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs sm:table-cell">
        <span
          className={cn(
            row.streak >= 3
              ? "font-semibold text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
          )}
          title="Số lần kết toán liên tiếp gần nhất có reward ≥ 0,5"
        >
          {nf0.format(row.streak)}
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span className="flex items-center gap-2">
          <Progress
            value={row.posteriorMean * 100}
            className="h-1.5 w-14 [&>div]:bg-emerald-600 dark:[&>div]:bg-emerald-400"
            aria-label={`Posterior bandit ${pct1(row.posteriorMean)}`}
          />
          <span className="tabular-nums text-xs font-semibold">
            {pct1(row.posteriorMean)}
          </span>
        </span>
      </TableCell>
      <TableCell
        className={cn(
          "hidden tabular-nums text-xs lg:table-cell",
          healthTone(row.healthScore)
        )}
      >
        {row.healthScore == null ? "—" : nf0.format(row.healthScore)}
      </TableCell>
    </TableRow>
  );
}

function ScorecardSkeleton() {
  return (
    <div
      className="flex flex-col gap-2 py-1"
      aria-busy="true"
      aria-label="Đang tải bảng điểm Hội đồng Nghiên cứu"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  );
}
