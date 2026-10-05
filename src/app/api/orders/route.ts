import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/orders — recent 20 orders (+ trades for the "Giao dịch" tab).
 */
export async function GET() {
  try {
    const [orders, trades] = await Promise.all([
      db.order.findMany({
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { instrument: { select: { symbol: true, name: true } } },
      }),
      db.trade.findMany({
        orderBy: { executedAt: "desc" },
        take: 20,
        include: { instrument: { select: { symbol: true, name: true } } },
      }),
    ]);

    return NextResponse.json(
      toPlain({
        orders: orders.map((o) => ({
          id: o.id,
          symbol: o.instrument.symbol,
          name: o.instrument.name,
          side: o.side,
          type: o.type,
          quantity: o.quantity,
          price: o.price,
          filledQuantity: o.filledQuantity,
          avgFillPrice: o.avgFillPrice,
          status: o.status,
          fee: o.fee,
          note: o.note,
          createdAt: o.createdAt,
          submittedAt: o.submittedAt,
          filledAt: o.filledAt,
        })),
        trades: trades.map((t) => ({
          id: t.id,
          symbol: t.instrument.symbol,
          name: t.instrument.name,
          side: t.side,
          quantity: t.quantity,
          price: t.price,
          value: t.quantity * t.price,
          fee: t.fee,
          tax: t.tax,
          executedAt: t.executedAt,
        })),
      })
    );
  } catch (err) {
    console.error("[api/orders]", err);
    return NextResponse.json(
      { error: "Không tải được dữ liệu lệnh." },
      { status: 500 }
    );
  }
}
