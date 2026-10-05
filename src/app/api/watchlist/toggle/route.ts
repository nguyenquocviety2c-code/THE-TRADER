import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/watchlist/toggle — thêm/gỡ một mã khỏi watchlist mặc định.
 * Body: { "symbol": "VCB" }. Trả về { symbol, inWatchlist, count }.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      symbol?: unknown;
    } | null;
    const symbol =
      typeof body?.symbol === "string" ? body.symbol.trim().toUpperCase() : "";

    if (!/^[A-Z0-9]{3,10}$/.test(symbol)) {
      return NextResponse.json(
        { error: "Mã chứng khoán không hợp lệ." },
        { status: 400 }
      );
    }

    const [instrument, watchlist] = await Promise.all([
      db.instrument.findUnique({
        where: { symbol },
        select: { id: true, symbol: true },
      }),
      db.watchlist.findFirst({
        where: { isDefault: true },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }),
    ]);

    if (!instrument) {
      return NextResponse.json(
        { error: `Không tìm thấy mã ${symbol} trên sàn.` },
        { status: 404 }
      );
    }
    if (!watchlist) {
      return NextResponse.json(
        { error: "Chưa có danh mục theo dõi mặc định." },
        { status: 404 }
      );
    }

    const existing = await db.watchlistItem.findUnique({
      where: {
        watchlistId_instrumentId: {
          watchlistId: watchlist.id,
          instrumentId: instrument.id,
        },
      },
      select: { id: true },
    });

    let inWatchlist: boolean;
    if (existing) {
      await db.watchlistItem.delete({ where: { id: existing.id } });
      inWatchlist = false;
    } else {
      await db.watchlistItem.create({
        data: { watchlistId: watchlist.id, instrumentId: instrument.id },
      });
      inWatchlist = true;
    }

    await db.auditLog.create({
      data: {
        action: inWatchlist ? "WATCHLIST_ADDED" : "WATCHLIST_REMOVED",
        entity: "WatchlistItem",
        entityId: instrument.id,
        after: JSON.stringify({ symbol, watchlistId: watchlist.id }),
      },
    });

    const count = await db.watchlistItem.count({
      where: { watchlistId: watchlist.id },
    });

    return NextResponse.json({ symbol, inWatchlist, count });
  } catch (err) {
    console.error("[api/watchlist/toggle]", err);
    return NextResponse.json(
      { error: "Không cập nhật được danh mục theo dõi." },
      { status: 500 }
    );
  }
}
