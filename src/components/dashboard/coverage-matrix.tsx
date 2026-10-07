"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  FileText,
  Globe2,
  Info,
  LayoutGrid,
  RefreshCw,
} from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiGet } from "@/lib/api";
import { formatVolume } from "@/lib/format";
import { cn } from "@/lib/utils";
// Type-only import (erased lúc compile — KHÔNG kéo server code vào client
// bundle); route /api/coverage là chủ hợp đồng shape này (B14 §3.7).
import type {
  CoverageCell,
  CoverageResponse,
  CoverageStatus,
  FundamentalsRow,
} from "@/app/api/coverage/route";

/* ═══════════ B14 — Ma trận độ phủ thị trường (tab Đội Agent, §3.7) ═══════════
 *
 * Lưới 5 cột (STOCK · ETF · FUND · BOND · INDEX) × 3 hàng (HOSE · HNX ·
 * UPCOM) — 15 ô LUÔN render kể cả ô 0 sản phẩm niêm yết (T14.1 trung thực,
 * không bịa dữ liệu) + hàng "Quốc tế (US · HK)" + dòng "Dữ liệu cơ bản (finfo)".
 *
 * Màu 3 trạng thái (§1.2 — TUYỆT ĐỐI không indigo/blue):
 *   🟢 real          bg-up/15 text-up
 *   ⚪ empty         muted ("0 sản phẩm niêm yết" — thị trường không có sản phẩm)
 *   🟡 pending-source bg-amber-500/15 text-amber-600 dark:text-amber-400
 *
 * Click ô → Tooltip chi tiết (T14.4): trạng thái đầy đủ + note + số liệu.
 * Mobile 390px KHÔNG tràn lưới (T14.3): <sm card-list stacked; ≥sm grid
 * minmax trong container overflow-x-auto.
 */

const GRID_MARKETS = ["HOSE", "HNX", "UPCOM"] as const;
const GRID_TYPES = ["STOCK", "ETF", "FUND", "BOND", "INDEX"] as const;

const TYPE_LABELS: Record<string, string> = {
  STOCK: "Cổ phiếu",
  ETF: "ETF",
  FUND: "Quỹ",
  BOND: "Trái phiếu",
  INDEX: "Chỉ số",
  MIXED: "Đa loại",
};

const STATUS_LABELS: Record<CoverageStatus, string> = {
  real: "Vận hành thật — dữ liệu đang chảy",
  empty: "0 sản phẩm niêm yết",
  "pending-source": "Chờ nguồn",
};

const nf0 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });

const dayMonthFmt = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
});

const dateFullFmt = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Ho_Chi_Minh",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** "07/10" — phiên bar cuối (bar.date 15:00 UTC → 22:00 ICT cùng ngày).
 * ICU vi-VN day+month mặc định ngăn "07-10" — ghép formatToParts theo dd/MM. */
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const parts = dayMonthFmt.formatToParts(new Date(iso));
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${day}/${month}`;
}

function fullDate(iso: string | null): string {
  if (!iso) return "—";
  return dateFullFmt.format(new Date(iso));
}

/** "96p" — tuổi quote theo PHÚT (spec B14: "tuổi quote phút"), null → "—". */
function ageCompact(min: number | null): string {
  if (min == null) return "—";
  return `${min}p`;
}

/** Badge 3 trạng thái — màu token ngữ nghĩa, không indigo/blue. */
function statusTone(status: CoverageStatus): string {
  switch (status) {
    case "real":
      return "bg-up/15 text-up border-up/30";
    case "pending-source":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
    default:
      return "bg-muted text-muted-foreground border-transparent";
  }
}

function statusShort(status: CoverageStatus): string {
  if (status === "real") return "real";
  if (status === "pending-source") return "chờ nguồn";
  return "0 mã";
}

function StatusBadge({ status }: { status: CoverageStatus }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        statusTone(status)
      )}
    >
      {statusShort(status)}
    </span>
  );
}

function cellAriaLabel(cell: CoverageCell): string {
  const typeLabel = TYPE_LABELS[cell.type] ?? cell.type;
  const parts = [
    `${cell.market} × ${typeLabel}`,
    STATUS_LABELS[cell.status],
    `${cell.instrumentCount} mã`,
    `${nf0.format(cell.barCount)} bar`,
  ];
  if (cell.lastBarDate) parts.push(`phiên cuối ${fullDate(cell.lastBarDate)}`);
  if (cell.quoteAgeMin != null) parts.push(`quote ${cell.quoteAgeMin} phút`);
  return parts.join(", ");
}

/** Tooltip chi tiết ô (T14.4) — note đầy đủ từ API, không thêm endpoint. */
function CellTooltipBody({ cell }: { cell: CoverageCell }) {
  return (
    <div className="flex flex-col gap-0.5 text-left text-xs leading-snug">
      <p className="font-semibold">
        {cell.market} × {TYPE_LABELS[cell.type] ?? cell.type}
      </p>
      <p className="text-background/80">{STATUS_LABELS[cell.status]}</p>
      <p className="max-w-60">{cell.note}</p>
      <p className="tabular-nums text-background/80">
        {cell.instrumentCount} mã · {nf0.format(cell.barCount)} bar
        {cell.lastBarDate ? ` · phiên cuối ${fullDate(cell.lastBarDate)}` : ""}
        {cell.quoteAgeMin != null ? ` · quote ${cell.quoteAgeMin} phút` : ""}
      </p>
    </div>
  );
}

/* ── Ô lưới desktop (≥sm): button + tooltip, min-h uniform ── */
function GridCell({ cell }: { cell: CoverageCell }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={cellAriaLabel(cell)}
          className={cn(
            "flex min-h-20 w-full flex-col items-start gap-1 rounded-lg border bg-card p-2 text-left",
            "transition-colors hover:border-foreground/30 hover:bg-muted/40",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          )}
        >
          <StatusBadge status={cell.status} />
          <span className="tabular-nums text-xs font-semibold leading-none">
            {cell.instrumentCount} mã
          </span>
          <span className="tabular-nums text-[11px] leading-none text-muted-foreground">
            {cell.barCount > 0 ? `${formatVolume(cell.barCount)} bar` : "0 bar"}
          </span>
          <span className="tabular-nums text-[11px] leading-none text-muted-foreground">
            {shortDate(cell.lastBarDate)} · {ageCompact(cell.quoteAgeMin)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <CellTooltipBody cell={cell} />
      </TooltipContent>
    </Tooltip>
  );
}

/* ── Hàng ô mobile (<sm): 1 dòng ngang, không tràn 390px (T14.3) ── */
function MobileCellRow({ cell }: { cell: CoverageCell }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={cellAriaLabel(cell)}
          className="flex min-h-11 w-full items-center gap-2 rounded-lg border bg-card px-2.5 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="w-[68px] shrink-0 truncate text-[11px] font-medium leading-tight">
            {TYPE_LABELS[cell.type] ?? cell.type}
          </span>
          <StatusBadge status={cell.status} />
          <span className="ml-auto flex shrink-0 flex-col items-end leading-tight">
            <span className="tabular-nums text-[11px] font-semibold">
              {cell.instrumentCount} mã ·{" "}
              {cell.barCount > 0 ? formatVolume(cell.barCount) : "0"} bar
            </span>
            <span className="tabular-nums text-[10px] text-muted-foreground">
              {shortDate(cell.lastBarDate)} · {ageCompact(cell.quoteAgeMin)}
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <CellTooltipBody cell={cell} />
      </TooltipContent>
    </Tooltip>
  );
}

/* ── Hàng quốc tế (US · HK) + dòng cơ bản (finfo) — dùng cả 2 breakpoint ── */
function IntlSection({ cells }: { cells: CoverageCell[] }) {
  return (
    <section aria-label="Độ phủ thị trường quốc tế" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <Globe2 className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Quốc tế (US · HK)
        </h4>
        <span className="text-[10px] text-muted-foreground/80">
          Yahoo Finance — job 06:15 ICT
        </span>
      </div>
      {/* ≥sm: 2 ô cạnh nhau; <sm: stack dọc */}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {cells.map((cell) => (
          <div key={cell.market} className="sm:hidden">
            <MobileCellRow cell={cell} />
          </div>
        ))}
        {cells.map((cell) => (
          <div key={`${cell.market}-grid`} className="hidden sm:block">
            <GridCell cell={cell} />
          </div>
        ))}
      </div>
    </section>
  );
}

function FundamentalsLine({ row }: { row: FundamentalsRow }) {
  return (
    <section
      aria-label="Độ phủ dữ liệu tài chính cơ bản"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-2.5 py-2"
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="text-xs font-medium leading-none">{row.label}</span>
      <StatusBadge status={row.status} />
      <span className="ml-auto flex items-center gap-2">
        <span className="tabular-nums text-[11px] leading-none text-muted-foreground">
          {nf0.format(row.rowsCount)} dòng ghi chép
        </span>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Chi tiết ${row.label}: ${STATUS_LABELS[row.status]}, mode ${row.mode}`}
                className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <Info className="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="flex max-w-60 flex-col gap-0.5 text-left text-xs leading-snug">
                <p className="font-semibold">{row.label}</p>
                <p>
                  {STATUS_LABELS[row.status]} · mode nguồn: {row.mode}
                </p>
                <p>{row.note}</p>
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
    </section>
  );
}

/* ── Legend 3 màu theo §1.2 ── */
function CoverageLegend() {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] leading-none text-muted-foreground"
      aria-hidden="true"
    >
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-up" />
        real — dữ liệu thật đang chảy
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-muted-foreground/40" />
        0 sản phẩm niêm yết — thị trường không có sản phẩm
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-amber-500" />
        chờ nguồn — có sản phẩm, chưa có nguồn xác minh
      </span>
    </div>
  );
}

/* ── Card chính ── */
export function CoverageMatrix() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["coverage"],
    queryFn: () => apiGet<CoverageResponse>("/api/coverage"),
    staleTime: 30_000,
  });

  const grid = data?.grid ?? [];
  const intlRow = data?.intlRow ?? [];

  return (
    <Card className="gap-4" aria-labelledby="coverage-matrix-heading">
      <CardHeader>
        <CardTitle
          id="coverage-matrix-heading"
          className="flex items-center gap-2 text-base"
        >
          <LayoutGrid className="size-4 text-muted-foreground" aria-hidden="true" />
          Ma trận độ phủ thị trường
        </CardTitle>
        <CardDescription>
          3 sàn niêm yết × 5 loại tài sản = 15 tổ hợp + quốc tế + dữ liệu cơ bản —
          trạng thái nguồn theo dữ liệu thật
        </CardDescription>
        {data?.generatedAt && (
          <CardAction>
            <span className="text-[11px] text-muted-foreground">
              Cập nhật{" "}
              {new Date(data.generatedAt).toLocaleString("vi-VN", {
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
          <CoverageSkeleton />
        ) : isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-down/40 bg-down/10 p-4 text-sm text-down"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <p className="min-w-40 flex-1 leading-relaxed">
              Không tải được ma trận độ phủ thị trường
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
          <>
            <CoverageLegend />

            {/* ≥sm: lưới 5 cột × 3 hàng — 15 ô luôn đủ (T14.1); container
                overflow-x-auto chống tràn (T14.3) */}
            <TooltipProvider delayDuration={200}>
              <div className="hidden overflow-x-auto custom-scrollbar sm:block">
                <div
                  role="table"
                  aria-label="Ma trận độ phủ: 3 sàn × 5 loại tài sản"
                  className="min-w-[480px]"
                >
                  <div
                    role="row"
                    className="grid grid-cols-[56px_repeat(5,minmax(76px,1fr))] gap-1.5 pb-1.5"
                  >
                    <div role="columnheader" className="sr-only">
                      Sàn niêm yết
                    </div>
                    {GRID_TYPES.map((t) => (
                      <div
                        key={t}
                        role="columnheader"
                        className="truncate text-center text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {TYPE_LABELS[t] ?? t}
                      </div>
                    ))}
                  </div>
                  {GRID_MARKETS.map((market, rowIdx) => (
                    <div
                      key={market}
                      role="row"
                      className="grid grid-cols-[56px_repeat(5,minmax(76px,1fr))] items-stretch gap-1.5 pb-1.5 last:pb-0"
                    >
                      <div
                        role="rowheader"
                        className="flex items-center text-[11px] font-semibold text-muted-foreground"
                      >
                        {market}
                      </div>
                      {(grid[rowIdx] ?? []).map((cell) => (
                        <div key={cell.market + cell.type} role="cell">
                          <GridCell cell={cell} />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* <sm: card-list stacked — không tràn 390px (T14.3) */}
              <div className="flex flex-col gap-3 sm:hidden">
                {GRID_MARKETS.map((market, rowIdx) => (
                  <section
                    key={market}
                    aria-label={`Độ phủ sàn ${market}`}
                    className="flex flex-col gap-1.5"
                  >
                    <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {market}
                    </h4>
                    {(grid[rowIdx] ?? []).map((cell) => (
                      <MobileCellRow key={cell.market + cell.type} cell={cell} />
                    ))}
                  </section>
                ))}
              </div>

              <IntlSection cells={intlRow} />
            </TooltipProvider>

            {data?.fundamentalsRow && (
              <FundamentalsLine row={data.fundamentalsRow} />
            )}

            {/* Sticky note trung thực (T14.1) */}
            <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                <span className="font-medium text-foreground">
                  15/15 vận hành
                </span>{" "}
                = hạ tầng đầy đủ + tự sáng khi dữ liệu xuất hiện — không tô xanh
                giả. Ô ⚪ là thị trường chưa có sản phẩm niêm yết (watcher re-probe
                Chủ nhật 04:00 ICT); ô 🟡 có sản phẩm thật nhưng chờ nguồn xác
                minh (bond chờ egress finfo; US · HK chờ job 06:15 ICT đổ bar
                Yahoo).
              </span>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CoverageSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Đang tải ma trận độ phủ thị trường"
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-4 w-72" />
      <div className="hidden gap-1.5 sm:grid sm:grid-cols-[56px_repeat(5,minmax(76px,1fr))]">
        {Array.from({ length: 18 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
      <div className="flex flex-col gap-1.5 sm:hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-9 w-full rounded-lg" />
    </div>
  );
}
