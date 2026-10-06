"use client";

import * as React from "react";
import { useRunAgents } from "@/hooks/use-run-agents";
import { useAssessment } from "@/hooks/use-assessment";
import { ArrowRight, Brain, Loader2, Play } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import type { MarketAssessmentView } from "@/lib/types";

/**
 * Phiên #34 — bản tóm tắt nhận định Bayes trên workspace Tổng quan.
 * Card gọn: badge hướng + stacked probability bar + 3 stat + caption nguồn;
 * nhấn "Xem chi tiết" → workspace synthesis. Chưa có assessment → empty state
 * kèm nút chạy chu kỳ 23 agents (assessment tự invalidate sau chu kỳ).
 */

const DIRECTION: Record<string, { label: string; className: string }> = {
  BULLISH: { label: "TĂNG", className: "bg-up/15 text-up hover:bg-up/15" },
  BEARISH: { label: "GIẢM", className: "bg-down/15 text-down hover:bg-down/15" },
  NEUTRAL: { label: "ĐI NGANG", className: "bg-muted text-muted-foreground hover:bg-muted" },
};

/** "42,3%" — NHẬP TỶ LỆ 0..1 (pUp/confidence…) → nhân 100; 1 chữ số, dấu phẩy VN. */
function pct1(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export function AssessmentBrief() {
  const { data, isLoading, isError, error, refetch } = useAssessment();
  const runAgents = useRunAgents();
  const setActiveWorkspace = useUiStore((s) => s.setActiveWorkspace);
  const assessment = data?.assessment ?? null;

  return (
    <section aria-label="Nhận định thị trường — Bộ tổng hợp Bayes">
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="size-4 text-muted-foreground" aria-hidden="true" />
            Nhận định thị trường — Bộ tổng hợp Bayes
          </CardTitle>
          <CardDescription>
            {assessment
              ? assessment.source === "cycle"
                ? `Nguồn: chu kỳ 23 agents lúc ${formatDateTime(assessment.createdAt)}`
                : "Tổng hợp lại thủ công"
              : "Tổng hợp đánh giá 23 agents theo mô hình nhân quả Bayes"}
          </CardDescription>
          {assessment && (
            <CardAction>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-xs text-muted-foreground"
                onClick={() => setActiveWorkspace("synthesis")}
                aria-label="Mở workspace Tổng hợp"
              >
                Xem chi tiết
                <ArrowRight className="size-3" aria-hidden="true" />
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-7 w-36" />
              <Skeleton className="h-7 w-full rounded-md" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : isError ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-down">
                {error?.message ?? "Không tải được nhận định."}
              </p>
              <Button variant="outline" size="sm" className="h-9" onClick={() => void refetch()}>
                Thử lại
              </Button>
            </div>
          ) : !assessment ? (
            /* Empty state — chưa chạy chu kỳ nào */
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4">
              <p className="text-sm text-muted-foreground">
                Bộ tổng hợp Bayes chưa chạy — chạy chu kỳ 23 agents để có nhận
                định thị trường.
              </p>
              <Button
                onClick={() => runAgents.mutate()}
                disabled={runAgents.isPending}
                className="min-h-11 gap-2"
              >
                {runAgents.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Đang phân tích…
                  </>
                ) : (
                  <>
                    <Play className="size-4" aria-hidden="true" />
                    Chạy chu kỳ 23 agents
                  </>
                )}
              </Button>
            </div>
          ) : (
            <AssessmentBriefBody assessment={assessment} />
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function AssessmentBriefBody({ assessment }: { assessment: MarketAssessmentView }) {
  const dir = DIRECTION[assessment.marketDirection] ?? DIRECTION.NEUTRAL;
  const { pUp, pFlat, pDown } = assessment;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge className={cn("px-3 py-1 text-sm font-bold tracking-wide", dir.className)}>
          {dir.label}
        </Badge>
        {/* Stacked probability bar 3 màu (pUp/pFlat/pDown) */}
        <div
          className="flex h-7 min-w-48 flex-1 overflow-hidden rounded-md border border-border/60"
          role="img"
          aria-label={`Xác suất tăng ${pct1(pUp)}, đi ngang ${pct1(pFlat)}, giảm ${pct1(pDown)}`}
        >
          <ProbSegment value={pUp} className="bg-up" tone="text-up" label="Tăng" />
          <ProbSegment value={pFlat} className="bg-muted-foreground/25" tone="text-foreground" label="Đi ngang" />
          <ProbSegment value={pDown} className="bg-down" tone="text-down" label="Giảm" />
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
        <span>
          Độ tin cậy{" "}
          <span className="tabular-nums font-semibold text-foreground">
            {pct1(assessment.confidence)}
          </span>
        </span>
        <span>
          Bất đồng{" "}
          <span className="tabular-nums font-semibold text-foreground">
            {pct1(assessment.disagreement)}
          </span>
        </span>
        <span>
          Số bằng chứng{" "}
          <span className="tabular-nums font-semibold text-foreground">
            {assessment.evidenceCount.toLocaleString("vi-VN")}
          </span>
        </span>
        {assessment.veto.blocked && (
          <Badge variant="outline" className="border-down/40 text-down">
            Ủy ban Kiểm soát phủ quyết
          </Badge>
        )}
      </div>
    </div>
  );
}

function ProbSegment({
  value,
  className,
  tone,
  label,
}: {
  value: number;
  className: string;
  tone: string;
  label: string;
}) {
  if (!Number.isFinite(value) || value <= 0) return null;
  // value là tỷ lệ 0..1 → CSS % cần ×100 (0.71 → 71%)
  const widthPct = Math.min(100, Math.max(0, value * 100));
  return (
    <div
      className={cn("flex items-center justify-center", className)}
      style={{ width: `${widthPct}%` }}
      title={`${label}: ${pct1(value)}`}
    >
      {widthPct >= 8 && (
        <span className={cn("tabular-nums text-[11px] font-semibold", tone)}>
          {pct1(value)}
        </span>
      )}
    </div>
  );
}
