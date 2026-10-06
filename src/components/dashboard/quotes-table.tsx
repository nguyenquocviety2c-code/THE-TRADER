"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Star, StarOff, TableProperties } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiGet, apiPostJson } from "@/lib/api";
import { useUiStore } from "@/lib/store";
import { changeColor, formatPrice, formatPct, formatSigned, formatVolume } from "@/lib/format";
import type { QuoteRow, QuotesResponse, WatchlistResponse, WatchlistToggleResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

export function QuotesTable() {
  const selectedSymbol = useUiStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUiStore((s) => s.setSelectedSymbol);
  const watchlistOnly = useUiStore((s) => s.watchlistOnly);
  const setWatchlistOnly = useUiStore((s) => s.setWatchlistOnly);
  // PHASE3 B3 §5.2 — toggle cột mở rộng (mặc định tắt, tránh tràn ngang mobile)
  const quotesExpanded = useUiStore((s) => s.quotesExpanded);
  const setQuotesExpanded = useUiStore((s) => s.setQuotesExpanded);

  const quotesQuery = useQuery({
    queryKey: ["quotes"],
    queryFn: () => apiGet<QuotesResponse>("/api/market/quotes"),
    staleTime: 30_000,
  });
  const watchlistQuery = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => apiGet<WatchlistResponse>("/api/market/watchlist"),
    staleTime: 30_000,
    // Luôn bật để biết mã nào đang có sao (kể cả khi không ở chế độ theo dõi)
  });

  // Danh sách mã đang theo dõi (để tô sao)
  const watchedSymbols = React.useMemo(
    () => new Set(watchlistQuery.data?.watchlist.quotes.map((q) => q.symbol) ?? []),
    [watchlistQuery.data]
  );

  const queryClient = useQueryClient();
  const toggleWatch = useMutation({
    mutationFn: (symbol: string) =>
      apiPostJson<WatchlistToggleResponse>("/api/watchlist/toggle", { symbol }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["watchlist"] });
      void queryClient.invalidateQueries({ queryKey: ["system-status"] });
      toast.success(
        res.inWatchlist
          ? `Đã thêm ${res.symbol} vào danh mục theo dõi (${res.count} mã)`
          : `Đã gỡ ${res.symbol} khỏi danh mục theo dõi (${res.count} mã)`
      );
    },
    onError: (err: Error) => {
      toast.error("Không cập nhật được danh mục theo dõi", {
        description: err.message,
      });
    },
  });

  const [search, setSearch] = React.useState("");

  const source: QuoteRow[] = React.useMemo(
    () =>
      watchlistOnly
        ? (watchlistQuery.data?.watchlist.quotes ?? [])
        : (quotesQuery.data?.quotes ?? []),
    [watchlistOnly, watchlistQuery.data, quotesQuery.data]
  );
  const totalCount = watchlistOnly
    ? (watchlistQuery.data?.watchlist.count ?? 0)
    : (quotesQuery.data?.quotes.length ?? 0);

  const quotes = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return source;
    return source.filter(
      (row) =>
        row.symbol.toLowerCase().includes(q) ||
        row.name.toLowerCase().includes(q) ||
        row.sector.toLowerCase().includes(q)
    );
  }, [source, search]);

  const isLoading = watchlistOnly && !watchlistQuery.data ? watchlistQuery.isLoading : quotesQuery.isLoading;
  const isError = watchlistOnly && !watchlistQuery.data ? watchlistQuery.isError : quotesQuery.isError;
  const error = watchlistOnly && !watchlistQuery.data ? watchlistQuery.error : quotesQuery.error;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">
          {watchlistOnly ? "Danh mục theo dõi" : "Bảng giá VN30"}
        </CardTitle>
        <CardDescription>Nhấp vào một mã để xem biểu đồ giá</CardDescription>
        <CardAction>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            {/* PHASE3 B3 §5.2 — cột mở rộng: Trần/Sàn/TC/Cao/Thấp */}
            <div
              className="flex items-center gap-2"
              title="Thêm cột Trần · Sàn · Tham chiếu · Cao · Thấp (chỉ hiển thị từ màn hình sm trở lên)"
            >
              <Switch
                id="quotes-expanded"
                checked={quotesExpanded}
                onCheckedChange={setQuotesExpanded}
                aria-label="Bật cột mở rộng (trần, sàn, tham chiếu, cao, thấp)"
              />
              <Label
                htmlFor="quotes-expanded"
                className="hidden cursor-pointer items-center gap-1 text-xs text-muted-foreground md:flex"
              >
                <TableProperties className="size-3.5" aria-hidden="true" />
                Cột mở rộng
              </Label>
            </div>
            <div
              className="flex items-center gap-2"
              title="Chỉ hiển thị các mã trong danh mục theo dõi mặc định"
            >
              <Switch
                id="watchlist-mode"
                checked={watchlistOnly}
                onCheckedChange={setWatchlistOnly}
                aria-label="Chỉ hiển thị danh mục theo dõi"
              />
              <Label
                htmlFor="watchlist-mode"
                className="hidden cursor-pointer items-center gap-1 text-xs text-muted-foreground sm:flex"
              >
                <Star className="size-3.5" aria-hidden="true" />
                Theo dõi
              </Label>
            </div>
            <div className="relative">
              <Search
                className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                type="search"
                inputMode="search"
                placeholder="Tìm mã / tên / ngành…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-36 pl-8 text-sm sm:w-48"
                aria-label="Tìm kiếm mã cổ phiếu, tên công ty hoặc ngành"
              />
            </div>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading ? (
          <div className="flex flex-col gap-2 px-6 pb-6">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="px-6 pb-6 text-sm text-down">
            {error?.message ?? "Không tải được bảng giá."}
          </p>
        ) : (
          <>
            <div className="max-h-96 overflow-y-auto custom-scrollbar">
              <Table className={cn(quotesExpanded ? "min-w-[900px]" : "min-w-[600px]")}>
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10 pl-6">
                      <span className="sr-only">Theo dõi</span>
                    </TableHead>
                    <TableHead>Mã</TableHead>
                    <TableHead className="text-right">Giá</TableHead>
                    <TableHead className="text-right">+/-</TableHead>
                    <TableHead className="text-right">%</TableHead>
                    <TableHead className="text-right">KL</TableHead>
                    <TableHead className="pr-6 text-right">Bid/Ask</TableHead>
                    {/* PHASE3 B3 §5.2 — cột mở rộng (chỉ ≥ sm) */}
                    <TableHead className="hidden text-right sm:table-cell">Trần</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Sàn</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">TC</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Cao</TableHead>
                    <TableHead className="hidden pr-6 text-right sm:table-cell">Thấp</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quotes.map((q) => (
                    <TableRow
                      key={q.symbol}
                      onClick={() => setSelectedSymbol(q.symbol)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedSymbol(q.symbol);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-label={`Chọn ${q.symbol}`}
                      className={cn(
                        "min-h-11 cursor-pointer transition-colors outline-none focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40",
                        q.symbol === selectedSymbol ? "bg-accent" : "hover:bg-accent/50"
                      )}
                    >
                      <TableCell className="w-10 py-2.5 pl-6">
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            "size-7 text-muted-foreground transition-colors hover:text-amber-500",
                            watchedSymbols.has(q.symbol) && "text-amber-500"
                          )}
                          aria-label={
                            watchedSymbols.has(q.symbol)
                              ? `Gỡ ${q.symbol} khỏi danh mục theo dõi`
                              : `Thêm ${q.symbol} vào danh mục theo dõi`
                          }
                          aria-pressed={watchedSymbols.has(q.symbol)}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleWatch.mutate(q.symbol);
                          }}
                        >
                          {watchedSymbols.has(q.symbol) ? (
                            <Star className="size-4 fill-current" aria-hidden="true" />
                          ) : (
                            <StarOff className="size-4" aria-hidden="true" />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell className="py-2.5">
                        <p className="font-semibold">{q.symbol}</p>
                        <p className="max-w-[160px] truncate text-[11px] text-muted-foreground">
                          {quotesExpanded
                            ? `TC ${formatPrice(q.refPrice)} · C ${formatPrice(q.high)} · T ${formatPrice(q.low)}`
                            : q.sector || q.name}
                        </p>
                      </TableCell>
                      <TableCell className="tabular-nums py-2.5 text-right font-medium">
                        {/* Q2 HOSE: chạm trần ⌃ / chạm sàn ⌄ */}
                        {q.ceilingPrice != null && q.last >= q.ceilingPrice ? (
                          <span className="font-bold text-up">
                            ⌃ {formatPrice(q.last)}
                          </span>
                        ) : q.floorPrice != null && q.last <= q.floorPrice ? (
                          <span className="font-bold text-down">
                            ⌄ {formatPrice(q.last)}
                          </span>
                        ) : (
                          formatPrice(q.last)
                        )}
                      </TableCell>
                      <TableCell className={`tabular-nums py-2.5 text-right ${changeColor(q.change)}`}>
                        {formatSigned(q.change)}
                      </TableCell>
                      <TableCell
                        className={`tabular-nums py-2.5 text-right font-medium ${changeColor(q.changePct)}`}
                      >
                        {formatPct(q.changePct)}
                      </TableCell>
                      <TableCell className="tabular-nums py-2.5 text-right text-muted-foreground">
                        {formatVolume(q.volume)}
                      </TableCell>
                      <TableCell className="tabular-nums py-2.5 pr-6 text-right text-xs">
                        <span className="text-up">{formatPrice(q.bidPrice)}</span>
                        <span className="text-muted-foreground"> / </span>
                        <span className="text-down">{formatPrice(q.askPrice)}</span>
                      </TableCell>
                      {/* PHASE3 B3 §5.2 — hàng cột mở rộng (≥ sm) */}
                      <TableCell className="hidden tabular-nums py-2.5 text-right font-semibold text-up sm:table-cell">
                        {formatPrice(q.ceilingPrice)}
                      </TableCell>
                      <TableCell className="hidden tabular-nums py-2.5 text-right font-semibold text-down sm:table-cell">
                        {formatPrice(q.floorPrice)}
                      </TableCell>
                      <TableCell className="hidden tabular-nums py-2.5 text-right text-muted-foreground sm:table-cell">
                        {formatPrice(q.refPrice)}
                      </TableCell>
                      <TableCell className="hidden tabular-nums py-2.5 text-right sm:table-cell">
                        {formatPrice(q.high)}
                      </TableCell>
                      <TableCell className="hidden tabular-nums py-2.5 pr-6 text-right sm:table-cell">
                        {formatPrice(q.low)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {quotes.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={12}
                        className="py-8 text-center text-sm text-muted-foreground"
                      >
                        Không tìm thấy mã phù hợp.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <p className="px-6 py-3 text-[11px] text-muted-foreground">
              Hiển thị {quotes.length}/{totalCount} mã{" "}
              {watchlistOnly ? "· danh mục theo dõi" : "· sắp xếp theo khối lượng"}
              {quotesExpanded ? " · cột mở rộng: trần/sàn/TC/cao/thấp" : ""}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
