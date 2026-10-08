import { NextResponse } from "next/server";
import {
  getNotifySettings,
  listOutbox,
  notifyStatus,
  retryPendingOutbox,
} from "@/lib/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * P2-1 (phiên #62) — GET /api/notify: cài đặt kênh (webhook/email, không
 * phải secret) + trạng thái outbox (pending/sent) + 20 row gần nhất cho UI
 * Cài đặt. POST /api/notify: quét thử gửi lại tối đa 10 row PENDING_EGRESS
 * (nút "Thử gửi lại" + curl — cùng đường S1 piggyback mỗi chu kỳ).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const [settings, status, outbox] = await Promise.all([
      getNotifySettings(),
      notifyStatus(),
      listOutbox(20),
    ]);
    return NextResponse.json({
      settings,
      status,
      outbox,
    });
  } catch (err) {
    console.error("[api/notify GET]", err);
    return NextResponse.json(
      { error: "Không đọc được trạng thái kênh thông báo." },
      { status: 500 }
    );
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    const result = await retryPendingOutbox(10);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[api/notify POST]", err);
    return NextResponse.json(
      { error: "Quét thử gửi lại thất bại." },
      { status: 500 }
    );
  }
}
