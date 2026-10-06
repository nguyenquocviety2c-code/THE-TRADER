import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/[id]/cancel — hủy lệnh đang chờ khớp (F-206 audit 19-b:
 * phủ audit runtime cho action ORDER_CANCELLED).
 *
 * Chỉ cho hủy lệnh PENDING/PARTIALLY_FILLED (phần chưa khớp). Lệnh đã khớp
 * toàn phần, đã hủy, bị từ chối… trả 409. Hủy không xoá dữ liệu khớp đã có
 * (Trade/giao dịch phần đã khớp được giữ nguyên).
 *
 * Điều kiện chạy đua với bộ khớp lệnh giấy (tick route): việc chuyển trạng
 * thái dùng điều kiện `status IN (PENDING, PARTIALLY_FILLED)` — bên nào giữ
 * được quyền chuyển trước thì bên còn lại no-op.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const order = await db.order.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        side: true,
        type: true,
        quantity: true,
        filledQuantity: true,
        price: true,
        instrument: { select: { symbol: true } },
      },
    });

    if (!order) {
      return NextResponse.json(
        { error: "Không tìm thấy lệnh." },
        { status: 404 }
      );
    }

    if (order.status !== "PENDING" && order.status !== "PARTIALLY_FILLED") {
      return NextResponse.json(
        {
          error: `Chỉ hủy được lệnh đang chờ khớp — lệnh này hiện ở trạng thái ${order.status}.`,
        },
        { status: 409 }
      );
    }

    const now = new Date();
    // Claim có điều kiện — chống chạy đua với fill engine trong tick route
    const claimed = await db.order.updateMany({
      where: { id, status: { in: ["PENDING", "PARTIALLY_FILLED"] } },
      data: { status: "CANCELLED", cancelledAt: now },
    });
    if (claimed.count === 0) {
      return NextResponse.json(
        { error: "Lệnh vừa thay đổi trạng thái (có thể đã khớp) — vui lòng làm mới." },
        { status: 409 }
      );
    }

    await db.auditLog.create({
      data: {
        userId: order.userId,
        action: "ORDER_CANCELLED",
        entity: "Order",
        entityId: order.id,
        before: JSON.stringify({
          status: order.status,
          filledQuantity: order.filledQuantity,
        }),
        after: JSON.stringify({
          status: "CANCELLED",
          symbol: order.instrument.symbol,
          side: order.side,
          quantity: order.quantity,
          price: order.price,
          mode: "paper",
        }),
      },
    });

    return NextResponse.json(
      toPlain({
        order: {
          id: order.id,
          symbol: order.instrument.symbol,
          side: order.side,
          type: order.type,
          quantity: order.quantity,
          price: order.price,
          filledQuantity: order.filledQuantity,
          status: "CANCELLED",
          cancelledAt: now,
        },
      })
    );
  } catch (err) {
    console.error("[api/orders/cancel]", err);
    return NextResponse.json(
      { error: "Không hủy được lệnh. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
