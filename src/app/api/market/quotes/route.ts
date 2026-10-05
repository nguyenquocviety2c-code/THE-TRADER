import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/quotes
 * All instruments + latest quote, sorted by volume desc, plus market summary.
 */
export async function GET() {
  try {
    const instruments = await db.instrument.findMany({
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
    });

    const quotes = instruments
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
          tradedAt: q?.tradedAt ?? null,
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

    const topGainer = quotes.reduce<QuoteTop | null>(
      (best, q) =>
        q.changePct > (best?.changePct ?? -Infinity)
          ? { symbol: q.symbol, changePct: q.changePct, last: q.last }
          : best,
      null
    );
    const topLoser = quotes.reduce<QuoteTop | null>(
      (worst, q) =>
        q.changePct < (worst?.changePct ?? Infinity)
          ? { symbol: q.symbol, changePct: q.changePct, last: q.last }
          : worst,
      null
    );

    return NextResponse.json(
      toPlain({
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
      })
    );
  } catch (err) {
    console.error("[api/market/quotes]", err);
    return NextResponse.json(
      { error: "Không tải được dữ liệu bảng giá." },
      { status: 500 }
    );
  }
}

interface QuoteTop {
  symbol: string;
  changePct: number;
  last: number;
}
