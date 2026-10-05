import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/** Round down to board lot of 100 shares (HOSE). */
function roundLot(qty: number): number {
  return Math.max(0, Math.floor(qty / 100) * 100);
}

/**
 * POST /api/signals/[id]/convert — convert a BUY/SELL signal into a
 * PENDING limit order on the VNDIRECT account.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const signal = await db.signal.findUnique({
      where: { id },
      include: {
        instrument: {
          select: {
            id: true,
            symbol: true,
            quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } },
          },
        },
        agent: { select: { code: true, name: true } },
      },
    });

    if (!signal) {
      return NextResponse.json(
        { error: "Không tìm thấy tín hiệu." },
        { status: 404 }
      );
    }
    if (signal.actedAt) {
      return NextResponse.json(
        { error: "Tín hiệu này đã được chuyển thành lệnh trước đó." },
        { status: 409 }
      );
    }
    if (signal.direction === "HOLD") {
      return NextResponse.json(
        { error: "Tín hiệu GIỮ KHÔNG thể chuyển thành lệnh." },
        { status: 400 }
      );
    }

    const [user, account] = await Promise.all([
      db.user.findFirst({ where: { isActive: true }, select: { id: true } }),
      db.brokerAccount.findFirst({
        where: { deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (!user || !account) {
      return NextResponse.json(
        { error: "Không tìm thấy người dùng hoặc tài khoản môi giới." },
        { status: 404 }
      );
    }

    const side = signal.direction; // BUY | SELL
    const price =
      signal.targetPrice ?? signal.instrument.quotes[0]?.last ?? 0;
    if (price <= 0) {
      return NextResponse.json(
        { error: "Không xác định được giá đặt cho lệnh." },
        { status: 400 }
      );
    }

    // Sizing: BUY → ~50tr VND budget; SELL → half of existing position
    let quantity: number;
    if (side === "BUY") {
      quantity = roundLot(50_000_000 / price);
    } else {
      const position = await db.position.findFirst({
        where: {
          brokerAccountId: account.id,
          instrumentId: signal.instrument.id,
          status: "OPEN",
        },
        select: { quantity: true },
      });
      if (!position || position.quantity < 100) {
        return NextResponse.json(
          { error: "Không có vị thế phù hợp để đặt lệnh BÁN." },
          { status: 400 }
        );
      }
      quantity = Math.max(100, roundLot(position.quantity / 2));
    }

    if (quantity < 100) {
      return NextResponse.json(
        { error: "Khối lượng tính toán nhỏ hơn 1 lot (100 cổ phiếu)." },
        { status: 400 }
      );
    }

    const order = await db.order.create({
      data: {
        userId: user.id,
        brokerAccountId: account.id,
        signalId: signal.id,
        instrumentId: signal.instrument.id,
        side,
        type: "LIMIT",
        quantity,
        price,
        status: "PENDING",
        note: `Từ tín hiệu ${side === "BUY" ? "MUA" : "BÁN"} ${signal.instrument.symbol}${
          signal.agent ? ` (agent ${signal.agent.name})` : ""
        }`,
      },
    });

    await db.signal.update({
      where: { id: signal.id },
      data: { actedAt: new Date() },
    });

    await db.auditLog.create({
      data: {
        userId: user.id,
        action: "ORDER_CREATED",
        entity: "Order",
        entityId: order.id,
        after: JSON.stringify({
          symbol: signal.instrument.symbol,
          side,
          quantity,
          price,
          signalId: signal.id,
        }),
      },
    });

    return NextResponse.json(
      toPlain({
        order: {
          id: order.id,
          symbol: signal.instrument.symbol,
          side: order.side,
          type: order.type,
          quantity: order.quantity,
          price: order.price,
          status: order.status,
          createdAt: order.createdAt,
        },
      })
    );
  } catch (err) {
    console.error("[api/signals/convert]", err);
    return NextResponse.json(
      { error: "Không chuyển được tín hiệu thành lệnh. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
