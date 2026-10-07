import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/watchlist — default watchlist + latest quote per item
 * (TECHNICAL_BLUEPRINT §4). Returns the same QuoteRow shape as
 * /api/market/quotes so the table can switch sources seamlessly.
 */
export async function GET() {
  try {
    const watchlist = await db.watchlist.findFirst({
      where: { isDefault: true },
      orderBy: { createdAt: "asc" },
      include: {
        items: {
          include: {
            instrument: {
              select: {
                symbol: true,
                name: true,
                sector: true,
                market: true,
                type: true,
                currency: true,
                quotes: {
                  orderBy: { tradedAt: "desc" },
                  take: 1,
                },
              },
            },
          },
          orderBy: { addedAt: "asc" },
        },
      },
    });

    if (!watchlist) {
      return NextResponse.json(
        { watchlist: { id: "", name: "", isDefault: true, count: 0, quotes: [] } }
      );
    }

    const quotes = watchlist.items
      .map((item) => {
        const q = item.instrument.quotes[0];
        return q
          ? {
              symbol: item.instrument.symbol,
              name: item.instrument.name,
              sector: item.instrument.sector ?? "",
              market: item.instrument.market,
              // B13 — group bảng giá theo sàn + đơn vị theo loại/tiền tệ
              type: item.instrument.type,
              currency: item.instrument.currency ?? "VND",
              last: q.last,
              high: q.high,
              low: q.low,
              change: q.change,
              changePct: q.changePct,
              volume: q.volume,
              bidPrice: q.bidPrice,
              askPrice: q.askPrice,
              bidVolume: q.bidVolume,
              askVolume: q.askVolume,
              refPrice: q.refPrice,
              ceilingPrice: q.ceilingPrice,
              floorPrice: q.floorPrice,
              tradedAt: q.tradedAt,
            }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    return NextResponse.json(
      toPlain({
        watchlist: {
          id: watchlist.id,
          name: watchlist.name,
          isDefault: watchlist.isDefault,
          count: quotes.length,
          quotes,
        },
      })
    );
  } catch (err) {
    console.error("[api/market/watchlist] error:", err);
    return NextResponse.json(
      { error: "Không tải được danh mục theo dõi." },
      { status: 500 }
    );
  }
}
