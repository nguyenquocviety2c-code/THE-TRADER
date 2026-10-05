import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/instruments/bars?symbol=VCB&days=90
 * OHLCV bars for charting + SMA20 (computed over full history before slicing).
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = (searchParams.get("symbol") ?? "VCB").toUpperCase().trim();
    const daysRaw = Number(searchParams.get("days") ?? 90);
    const days = Number.isFinite(daysRaw)
      ? Math.min(Math.max(Math.round(daysRaw), 10), 250)
      : 90;

    const instrument = await db.instrument.findUnique({
      where: { symbol },
      select: { id: true, symbol: true, name: true },
    });
    if (!instrument) {
      return NextResponse.json(
        { error: `Không tìm thấy mã chứng khoán ${symbol}.` },
        { status: 404 }
      );
    }

    const [allBars, quote] = await Promise.all([
      db.bar.findMany({
        where: { instrumentId: instrument.id },
        orderBy: { date: "asc" },
        select: {
          date: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true,
          value: true,
        },
      }),
      db.quote.findFirst({
        where: { instrumentId: instrument.id },
        orderBy: { tradedAt: "desc" },
        select: { last: true, change: true, changePct: true },
      }),
    ]);

    // SMA20 over the full series so early sliced points stay accurate
    const closes = allBars.map((b) => b.close);
    const sma20: (number | null)[] = allBars.map((_, idx) => {
      if (idx < 19) return null;
      const window = closes.slice(idx - 19, idx + 1);
      return window.reduce((s, c) => s + c, 0) / 20;
    });

    const bars = allBars.slice(-days).map((b, i) => {
      const idx = allBars.length - days + i;
      return {
        date: b.date.toISOString().slice(0, 10),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        value: b.value,
        sma20: sma20[idx],
      };
    });

    return NextResponse.json(
      toPlain({
        symbol: instrument.symbol,
        name: instrument.name,
        days,
        last: quote?.last ?? bars.at(-1)?.close ?? 0,
        change: quote?.change ?? 0,
        changePct: quote?.changePct ?? 0,
        bars,
      })
    );
  } catch (err) {
    console.error("[api/instruments/bars]", err);
    return NextResponse.json(
      { error: "Không tải được dữ liệu biểu đồ." },
      { status: 500 }
    );
  }
}
