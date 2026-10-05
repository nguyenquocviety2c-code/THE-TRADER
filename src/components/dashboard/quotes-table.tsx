"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { changeColor, formatPrice, formatPct, formatSigned, formatVolume } from "@/lib/format";
import type { QuoteRow, QuotesResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

export function QuotesTable({
  selectedSymbol,
  onSelect,
}: {
  selectedSymbol: string;
  onSelect: (symbol: string) => void;
}) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["quotes"],
    queryFn: () => apiGet<QuotesResponse>("/api/market/quotes"),
  });
  const [search, setSearch] = React.useState("");

  const quotes = React.useMemo(() => {
    if (!data) return [] as QuoteRow[];
    const q = search.trim().toLowerCase();
    if (!q) return data.quotes;
    return data.quotes.filter(
      (row) =>
        row.symbol.toLowerCase().includes(q) ||
        row.name.toLowerCase().includes(q) ||
        row.sector.toLowerCase().includes(q)
    );
  }, [data, search]);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">Bảng giá VN30</CardTitle>
        <CardDescription>Nhấp vào một mã để xem biểu đồ giá</CardDescription>
        <CardAction>
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
              className="h-9 w-44 pl-8 text-sm sm:w-56"
              aria-label="Tìm kiếm mã chứng khoán"
            />
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
              <Table className="min-w-[560px]">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6">Mã</TableHead>
                    <TableHead className="text-right">Giá</TableHead>
                    <TableHead className="text-right">+/-</TableHead>
                    <TableHead className="text-right">%</TableHead>
                    <TableHead className="text-right">KL</TableHead>
                    <TableHead className="pr-6 text-right">Bid/Ask</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quotes.map((q) => (
                    <TableRow
                      key={q.symbol}
                      onClick={() => onSelect(q.symbol)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelect(q.symbol);
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
                      <TableCell className="py-2.5 pl-6">
                        <p className="font-semibold">{q.symbol}</p>
                        <p className="max-w-[160px] truncate text-[11px] text-muted-foreground">
                          {q.sector || q.name}
                        </p>
                      </TableCell>
                      <TableCell className="tabular-nums py-2.5 text-right font-medium">
                        {formatPrice(q.last)}
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
                    </TableRow>
                  ))}
                  {quotes.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
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
              Hiển thị {quotes.length}/{data?.quotes.length ?? 0} mã · sắp xếp theo
              khối lượng
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
