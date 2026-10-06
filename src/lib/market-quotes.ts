import { db } from "@/lib/db";
import type { MarketSummary, QuoteRow, QuotesResponse } from "@/lib/types";

/**
 * Builder chung cho payload bảng giá VN30 + summary — dùng bởi cả
 * GET /api/market/quotes và POST /api/market/tick (S4) để hai đường
 * trả về đúng cùng một shape cho UI và WebSocket broadcast.
 * F-117 (audit): meta.mode lấy từ DataSourceStatus thật (market-quotes)
 * thay vì hardcode "simulated" — trung thực với trạng thái nguồn.
 */
export async function loadQuotesPayload(): Promise<
  QuotesResponse & { meta: { mode: string; asOf: string } }
> {
  const [instruments, sourceStatus] = await Promise.all([
    db.instrument.findMany({
      where: { isActive: true },
      select: {
        symbol: true,
        name: true,
        sector: true,
        market: true,
        quotes: {
          orderBy: { tradedAt: "desc" },
          take: 1,
          select: {
            last: true,
            change: true,
            changePct: true,
            volume: true,
            bidPrice: true,
            askPrice: true,
            bidVolume: true,
            askVolume: true,
            refPrice: true,
            ceilingPrice: true,
            floorPrice: true,
            tradedAt: true,
          },
        },
      },
    }),
    db.dataSourceStatus.findUnique({
      where: { key: "market-quotes" },
      select: { mode: true },
    }),
  ]);

  const quotes: QuoteRow[] = instruments
    .map((i) => {
      const q = i.quotes[0];
      return {
        symbol: i.symbol,
        name: i.name,
        sector: i.sector ?? "",
        market: i.market,
        last: q?.last ?? 0,
        change: q?.change ?? 0,
        changePct: q?.changePct ?? 0,
        volume: q?.volume ?? 0,
        bidPrice: q?.bidPrice ?? null,
        askPrice: q?.askPrice ?? null,
        bidVolume: q?.bidVolume ?? null,
        askVolume: q?.askVolume ?? null,
        refPrice: q?.refPrice ?? null,
        ceilingPrice: q?.ceilingPrice ?? null,
        floorPrice: q?.floorPrice ?? null,
        tradedAt: q?.tradedAt?.toISOString() ?? new Date(0).toISOString(),
      };
    })
    .filter((q) => q.last > 0)
    .sort((a, b) => b.volume - a.volume);

  const advancing = quotes.filter((q) => q.change > 0).length;
  const declining = quotes.filter((q) => q.change < 0).length;
  const unchanged = quotes.length - advancing - declining;
  const totalVolume = quotes.reduce((s, q) => s + q.volume, 0);
  const totalValue = quotes.reduce((s, q) => s + q.volume * q.last, 0);
  const avgChangePct =
    quotes.length > 0
      ? quotes.reduce((s, q) => s + q.changePct, 0) / quotes.length
      : 0;

  // VN30 proxy index level: base 1000 × mean(last / refPrice)
  const ratios = quotes
    .filter((q) => q.refPrice && q.refPrice > 0)
    .map((q) => q.last / (q.refPrice as number));
  const indexLevel =
    ratios.length > 0
      ? 1000 * (ratios.reduce((s, r) => s + r, 0) / ratios.length)
      : 1000;

  const topGainer = quotes.reduce<MarketSummary["topGainer"]>(
    (best, q) =>
      q.changePct > (best?.changePct ?? -Infinity)
        ? { symbol: q.symbol, changePct: q.changePct, last: q.last }
        : best,
    null,
  );
  const topLoser = quotes.reduce<MarketSummary["topLoser"]>(
    (worst, q) =>
      q.changePct < (worst?.changePct ?? Infinity)
        ? { symbol: q.symbol, changePct: q.changePct, last: q.last }
        : worst,
    null,
  );

  const latestTradedAt = quotes.reduce<string>((max, q) => {
    return q.tradedAt > max ? q.tradedAt : max;
  }, new Date(0).toISOString());

  return {
    quotes,
    summary: {
      indexLevel,
      avgChangePct,
      advancing,
      declining,
      unchanged,
      count: quotes.length,
      totalVolume,
      totalValue,
      topGainer,
      topLoser,
    },
    meta: { mode: sourceStatus?.mode ?? "simulated", asOf: latestTradedAt },
  };
}
