import { NextResponse } from "next/server";
import {
  getNotifySettings,
  listOutbox,
  notifyStatus,
  retryPendingOutbox,
} from "@/lib/notify";

export const dynamic = "force-dynamic";
// F-63B-08/#63 — worst-case N row × 6s timeout webhook tuần tự + overhead
// (limit ≤ 10 mặc định → ~66s; nâng 30 → 90 cho du-room limit ≤ 50 chọn tay
// — self-hosted PM2 không enforce, đây là tài liệu cho deploy Vercel).
export const maxDuration = 90;

/**
 * P2-1 (phiên #62) — GET /api/notify: cài đặt kênh (webhook/email, không
 * phải secret) + trạng thái outbox (pending/sent) + 20 row gần nhất cho UI
 * Cài đặt. POST /api/notify: quét thử gửi lại tối đa 10 row PENDING_EGRESS
 * WEBHOOK (nút "Thử gửi lại" + curl — cùng đường S1 piggyback mỗi chu kỳ).
 *
 * F-63B-08/#63 — POST nhận body tuỳ chọn {limit: 1-50} (mặc định 10);
 * kiểu sai → 400 (trước fix route bỏ qua body hoàn toàn — nuốt input câm).
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

export async function POST(req: Request): Promise<NextResponse> {
  try {
    // F-63B-08/#63 — đọc + validate body {limit?} (không body → mặc định 10)
    let limit = 10;
    const raw = await req.text();
    if (raw.trim() !== "") {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return NextResponse.json(
          { error: "Body phải là JSON hợp lệ (vd {} hoặc {\"limit\":10})." },
          { status: 400 }
        );
      }
      if (body == null || typeof body !== "object" || Array.isArray(body)) {
        return NextResponse.json(
          { error: "Body phải là object JSON { limit?: number }." },
          { status: 400 }
        );
      }
      const v = (body as { limit?: unknown }).limit;
      if (v !== undefined) {
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 50) {
          return NextResponse.json(
            { error: "limit phải là số nguyên 1-50." },
            { status: 400 }
          );
        }
        limit = v;
      }
    }
    // F-63B-05/#64 — manual:true: nút "Thử gửi lại" là ý định tường minh của
    // người bấm → vẫn bắn kể cả khi notify.enabled=false (retry TỰ ĐỘNG S1
    // piggyback tôn trọng switch — xem lib/notify.ts).
    const result = await retryPendingOutbox(limit, { manual: true });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[api/notify POST]", err);
    return NextResponse.json(
      { error: "Quét thử gửi lại thất bại." },
      { status: 500 }
    );
  }
}
