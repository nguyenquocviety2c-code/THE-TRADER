"use client";

import * as React from "react";
import {
  AlertTriangle,
  Brain,
  Clock,
  Dumbbell,
  Layers,
  Loader2,
  RefreshCw,
  Scale,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isMlNotFound, useMlStatus, useTrainMl } from "@/hooks/use-ml";
import type {
  BanditArm,
  DlMlpMetrics,
  MlModelStatus,
  RlQMetrics,
} from "@/hooks/use-ml";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Phiên #35 (Task 35-FE) — card "Học máy & Học tăng cường" trong workspace
 * Tổng hợp. Hiển thị trạng thái 3 mô hình học THẬT của hệ thống:
 *
 *   1. MLP dự báo 5 phiên (học sâu — backprop + Adam)
 *   2. Q-learning Gym (học tăng cường — tabular 48 trạng thái)
 *   3. Bandit Thompson sampling (trọng số phiếu LLM — Beta-Bernoulli)
 *
 * Backend 35-ML chạy song song: GET /api/ml/status có thể 404 → render
 * empty-state "Đang chờ backend học máy" (query vẫn polling 30s để tự lành),
 * dlMlp/rlQ có thể null → mỗi khối có empty-state riêng. Màu chỉ dùng
 * emerald / rose / amber / neutral theo token ngữ nghĩa of app.
 */

/* ─────────────────── Format helpers (vi-VN, "%"/số có dấu − U+2212) ─────────────────── */

const nf0 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const nf2 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "61,0%" — nhập tỷ lệ 0..1 → ×100. */
function pct1(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${nf1.format(n * 100)}%`;
}

/** "−0,12" / "+0,40" (2 chữ số, dấu − U+2212). */
function signed2(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const s = nf2.format(Math.abs(n));
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : "0,00";
}

function clamp01(n: number | null | undefined): number {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Xanh (emerald) khi ≥50%, đỏ (rose) khi <50% — cho độ chính xác 0..1. */
function accTone(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "text-muted-foreground";
  return n >= 0.5
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
}

/** Dấu số: dương = emerald, âm = rose, 0/không xác định = muted. */
function signTone(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n) || n === 0) return "text-muted-foreground";
  return n > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
}

/* ─────────────────── Label maps ─────────────────── */

const MODEL_STATUS: Record<string, { label: string; className: string }> = {
  serving: {
    label: "serving",
    className: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400",
  },
  training: {
    label: "training",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
};

/** Chuẩn hoá stance (API trả tiếng Việt) → tăng / giữ / giảm. */
function normalizeStance(stance: string | null | undefined): "up" | "hold" | "down" {
  const s = (stance ?? "").trim().toLowerCase();
  if (["tăng", "tang", "up", "buy", "long"].includes(s)) return "up";
  if (["giảm", "giam", "down", "sell", "short"].includes(s)) return "down";
  return "hold";
}

const RL_STANCE: Record<"up" | "hold" | "down", { label: string; className: string }> = {
  up: {
    label: "TĂNG",
    className: "bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-600/15",
  },
  hold: {
    label: "GIỮ",
    className: "bg-amber-500/15 text-amber-700 dark:text-amber-400 hover:bg-amber-500/15",
  },
  down: {
    label: "GIẢM",
    className: "bg-rose-600/15 text-rose-700 dark:text-rose-400 hover:bg-rose-600/15",
  },
};

/* ─────────────────── Panel ─────────────────── */

export function MlPanel() {
  const { data, isLoading, isError, error, refetch } = useMlStatus();
  const train = useTrainMl();

  // 404 = backend 35-ML chưa merge → empty-state lịch sự (không crash).
  const waitingBackend = isError && isMlNotFound(error);
  // Khi chưa có backend thì không cho train (POST cũng 404 → chỉ toast lỗi).
  const trainDisabled = train.isPending || waitingBackend;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"
            aria-hidden="true"
          >
            <Brain className="size-4 text-foreground/80" />
          </span>
          Học máy &amp; Học tăng cường
        </CardTitle>
        <CardDescription>
          3 mô hình học thật chạy thuật toán trong code: MLP backprop+Adam ·
          Q-learning tabular 48 trạng thái · Thompson sampling Beta-Bernoulli
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <MlPanelSkeleton />
        ) : waitingBackend ? (
          <WaitingBackend />
        ) : isError ? (
          <MlErrorState
            message={error?.message ?? ""}
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            {/* Khối 1 — MLP dự báo 5 phiên (học sâu) */}
            <MlpBlock model={data?.dlMlp ?? null} />

            <Separator />

            {/* Khối 2 — Q-learning Gym (học tăng cường) */}
            <RlBlock model={data?.rlQ ?? null} />

            <Separator />

            {/* Khối 3 — Bandit Thompson sampling (trọng số phiếu LLM) */}
            <BanditBlock
              bandit={data?.bandit ?? null}
              pendingSettles={data?.pendingSettles ?? 0}
            />
          </>
        )}

        {/* Hành động — cuối card */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4">
          <TooltipProvider delayDuration={200}>
            <UiTooltip>
              <TooltipTrigger asChild>
                <Button
                  className="min-h-11 gap-2"
                  onClick={() => train.mutate("all")}
                  disabled={trainDisabled}
                >
                  {train.isPending ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      Đang huấn luyện…
                    </>
                  ) : (
                    <>
                      <Zap className="size-4" aria-hidden="true" />
                      Huấn luyện mô hình
                    </>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Train lại MLP + Q-learning trên dữ liệu EOD thật
              </TooltipContent>
            </UiTooltip>
          </TooltipProvider>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Huấn luyện lại chạy đúng thuật toán trong code — không tốn chi phí
            LLM.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── Tiểu khối dùng chung ─────────────────── */

/** Ô số liệu: nhãn muted + giá trị tabular-nums. */
function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-muted/30 px-3 py-2">
      <span className="text-[11px] leading-tight text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums text-lg font-semibold leading-tight", tone)}>
        {value}
      </span>
    </div>
  );
}

/** Badge phiên bản "v2". */
function VersionBadge({ version }: { version: number }) {
  return (
    <Badge variant="secondary" className="font-mono text-[10px]">
      v{version}
    </Badge>
  );
}

/** Badge trạng thái mô hình — "serving" emerald, còn lại outline thô. */
function StatusBadge({ status }: { status: string }) {
  const known = MODEL_STATUS[(status ?? "").toLowerCase()];
  if (known) {
    return (
      <Badge className={cn("font-mono text-[10px]", known.className)}>{known.label}</Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
      {status || "—"}
    </Badge>
  );
}

/** Dòng meta "Huấn luyện lúc …" căn phải hàng tiêu đề khối. */
function TrainedAtCaption({ trainedAt }: { trainedAt: string | null | undefined }) {
  if (!trainedAt) return null;
  return (
    <span className="ml-auto text-[11px] text-muted-foreground">
      Huấn luyện {formatDateTime(trainedAt)}
    </span>
  );
}

/** Empty-state 1 khối (dlMlp/rlQ null — chưa train). */
function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-3 text-sm leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

/* ─────────────────── Khối 1 — MLP dự báo 5 phiên ─────────────────── */

function MlpBlock({ model }: { model: MlModelStatus<DlMlpMetrics> | null }) {
  const m = model?.metrics;
  const topSymbols = (m?.topSymbols ?? []).filter(Boolean).slice(0, 8);

  return (
    <section aria-labelledby="ml-mlp-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-mlp-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <Layers className="size-4 text-muted-foreground" aria-hidden="true" />
          MLP dự báo 5 phiên (học sâu)
        </h3>
        {model && <VersionBadge version={model.version} />}
        {model && <StatusBadge status={model.status} />}
        {model && <TrainedAtCaption trainedAt={model.trainedAt} />}
      </div>

      {!model || !m ? (
        <EmptyNote>
          Chưa huấn luyện — bấm <strong className="font-semibold">Huấn luyện</strong>{" "}
          để train MLP trên dữ liệu EOD thật.
        </EmptyNote>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Epochs" value={nf0.format(m.epochs)} />
            <Stat label="Mẫu dữ liệu" value={nf0.format(m.samples)} />
            <Stat label="Độ chính xác train" value={pct1(m.trainAcc)} tone={accTone(m.trainAcc)} />
            <Stat label="Độ chính xác xác thực" value={pct1(m.valAcc)} tone={accTone(m.valAcc)} />
            <Stat label="Loss xác thực" value={nf2.format(m.valLoss)} />
            <Stat
              label="Cấu hình"
              value={
                <span className="text-sm font-semibold">
                  {m.horizonDays} phiên · {m.features} đặc trưng
                </span>
              }
            />
          </div>

          {topSymbols.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">
                Mã đóng góp mạnh nhất:
              </span>
              {topSymbols.map((sym) => (
                <Badge
                  key={sym}
                  variant="outline"
                  className="font-mono text-[10px] font-semibold"
                >
                  {sym}
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ─────────────────── Khối 2 — Q-learning Gym ─────────────────── */

function RlBlock({ model }: { model: MlModelStatus<RlQMetrics> | null }) {
  const m = model?.metrics;
  const stance = RL_STANCE[normalizeStance(m?.stance)];
  const exposurePct = clamp01(m?.exposure) * 100;

  return (
    <section aria-labelledby="ml-rlq-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-rlq-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <Dumbbell className="size-4 text-muted-foreground" aria-hidden="true" />
          Q-learning Gym (học tăng cường)
        </h3>
        {model && <VersionBadge version={model.version} />}
        {model && <StatusBadge status={model.status} />}
        {model && <TrainedAtCaption trainedAt={model.trainedAt} />}
      </div>

      {!model || !m ? (
        <EmptyNote>
          Chưa huấn luyện — bấm <strong className="font-semibold">Huấn luyện</strong>{" "}
          để chạy gym Q-learning trên dữ liệu EOD thật.
        </EmptyNote>
      ) : (
        <>
          {/* Stance hiện tại + phơi nhiễm + kích thước không gian */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              Stance hiện tại
              <Badge className={cn("px-2.5 text-[11px] font-bold tracking-wide", stance.className)}>
                {stance.label}
              </Badge>
            </span>
            <span className="flex items-center gap-2">
              Phơi nhiễm
              <span className="flex items-center gap-2">
                <span
                  className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"
                  aria-hidden="true"
                >
                  <span
                    className="block h-full rounded-full bg-amber-500"
                    style={{ width: `${exposurePct}%` }}
                  />
                </span>
                <span className="tabular-nums font-semibold">{pct1(m.exposure)}</span>
              </span>
            </span>
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              {m.states} trạng thái × {m.actions} hành động
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Episodes" value={nf0.format(m.episodes)} />
            <Stat label="ε cuối" value={nf2.format(m.epsilonEnd)} />
            <Stat
              label="Thưởng TB 50 ep cuối"
              value={signed2(m.avgRewardLast50)}
              tone={signTone(m.avgRewardLast50)}
            />
            <Stat label="Q-max" value={signed2(m.qMax)} tone={signTone(m.qMax)} />
          </div>
        </>
      )}
    </section>
  );
}

/* ─────────────────── Khối 3 — Bandit Thompson sampling ─────────────────── */

function BanditBlock({
  bandit,
  pendingSettles,
}: {
  bandit: { arms: BanditArm[]; lastSettleAt: string | null } | null;
  pendingSettles: number;
}) {
  // Sort giảm dần posteriorMean — tự phòng vệ bất kể thứ tự API.
  const arms = React.useMemo(
    () =>
      [...(bandit?.arms ?? [])].sort(
        (a, b) => clamp01(b.posteriorMean) - clamp01(a.posteriorMean)
      ),
    [bandit?.arms]
  );

  return (
    <section aria-labelledby="ml-bandit-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id="ml-bandit-heading"
          className="flex items-center gap-2 text-sm font-semibold"
        >
          <Scale className="size-4 text-muted-foreground" aria-hidden="true" />
          Bandit Thompson sampling (trọng số phiếu LLM)
        </h3>
        {pendingSettles > 0 && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {pendingSettles.toLocaleString("vi-VN")} phiếu chờ kết toán
          </Badge>
        )}
        {bandit?.lastSettleAt && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            Kết toán lần cuối {formatDateTime(bandit.lastSettleAt)}
          </span>
        )}
      </div>

      {arms.length === 0 ? (
        <EmptyNote>
          Chưa có arm nào — arms Beta-Bernoulli xuất hiện sau phiếu bầu đầu tiên
          của các agent LLM và được kết toán reward sau 5 phiên.
        </EmptyNote>
      ) : (
        <div className="max-h-64 overflow-y-auto custom-scrollbar rounded-lg border">
          {/* table-fixed mobile: hàng gộp 1 cell không đẩy bảng rộng hơn container */}
          <Table className="table-fixed sm:table-auto">
            <TableHeader>
              {/* Bảng header đầy đủ — desktop; mobile dùng hàng gộp (không header) */}
              <TableRow className="hidden sm:table-row">
                <TableHead className="text-xs">Agent</TableHead>
                <TableHead className="text-xs">α</TableHead>
                <TableHead className="text-xs">β</TableHead>
                <TableHead className="text-xs">Pulls</TableHead>
                <TableHead className="text-xs">Wins</TableHead>
                <TableHead className="text-xs">Posterior</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {arms.map((arm) => (
                <ArmRow key={arm.agentCode} arm={arm} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Reward = phiếu bầu đúng hướng giá thực tế sau 5 phiên · Beta(α+1,β+1)
      </p>
    </section>
  );
}

function ArmRow({ arm }: { arm: BanditArm }) {
  const mean = clamp01(arm.posteriorMean);
  const name = arm.name || arm.agentCode;
  const meta = `${arm.agentCode} · α ${nf1.format(arm.alpha)} · β ${nf1.format(arm.beta)} · ${nf0.format(arm.pulls)} pulls · ${nf1.format(arm.wins)} wins`;

  return (
    <TableRow>
      {/* Mobile — 1 hàng gộp (không tràn cột ở 390px) */}
      <TableCell colSpan={6} className="sm:hidden">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <span className="truncate text-xs font-semibold" title={name}>
              {name}
            </span>
            <span className="truncate text-[10px] text-muted-foreground" title={meta}>
              {meta}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-2">
            <Progress
              value={mean * 100}
              className="h-1.5 w-14 [&>div]:bg-emerald-600 dark:[&>div]:bg-emerald-400"
              aria-label={`Posterior mean ${pct1(mean)}`}
            />
            <span className="tabular-nums text-xs font-semibold">{pct1(mean)}</span>
          </span>
        </div>
      </TableCell>

      {/* Desktop — 6 cột đầy đủ */}
      <TableCell className="hidden sm:table-cell">
        <div className="flex flex-col leading-tight">
          <span className="max-w-28 truncate text-xs font-semibold" title={name}>
            {name}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {arm.agentCode}
          </span>
        </div>
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {nf1.format(arm.alpha)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {nf1.format(arm.beta)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs sm:table-cell">
        {nf0.format(arm.pulls)}
      </TableCell>
      <TableCell className="hidden tabular-nums text-xs text-muted-foreground sm:table-cell">
        {nf1.format(arm.wins)}
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span className="flex items-center gap-2">
          <Progress
            value={mean * 100}
            className="h-1.5 w-20 [&>div]:bg-emerald-600 dark:[&>div]:bg-emerald-400"
            aria-label={`Posterior mean ${pct1(mean)}`}
          />
          <span className="tabular-nums text-xs font-semibold">{pct1(mean)}</span>
        </span>
      </TableCell>
    </TableRow>
  );
}

/* ─────────────────── Trạng thái đặc biệt ─────────────────── */

/** Backend 35-ML chưa merge (GET 404) — empty-state lịch sự, query polling tự lành. */
function WaitingBackend() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/20 p-4">
      <Clock
        className="mt-0.5 size-4 shrink-0 animate-pulse text-muted-foreground"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-sm font-medium">Đang chờ backend học máy</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          API /api/ml/status chưa sẵn sàng (đang được triển khai song song) —
          thẻ tự động tải lại mỗi 30 giây khi có dữ liệu.
        </p>
      </div>
    </div>
  );
}

/** Lỗi khác 404 — banner + Thử lại (không crash workspace). */
function MlErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-down/40 bg-down/10 p-4 text-sm text-down"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      <p className="min-w-40 flex-1 leading-relaxed">
        Không tải được trạng thái học máy{message ? ` — ${message}` : "."}
      </p>
      <Button variant="outline" size="sm" className="gap-2" onClick={onRetry}>
        <RefreshCw className="size-3.5" aria-hidden="true" />
        Thử lại
      </Button>
    </div>
  );
}

/* ─────────────────── Skeleton ─────────────────── */

function MlPanelSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      aria-busy="true"
      aria-label="Đang tải trạng thái học máy"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-10 w-2/3" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}
