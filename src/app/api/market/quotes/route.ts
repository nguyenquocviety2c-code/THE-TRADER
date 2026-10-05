import { NextResponse } from "next/server";
import { loadQuotesPayload } from "@/lib/market-quotes";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/quotes
 * Toàn bộ VN30 + quote mới nhất (volume desc) + summary + meta nguồn
 * (mode/asOf — S4 stale marking). Dùng builder chung với POST /api/market/tick
 * để UI và WebSocket broadcast nhận cùng một shape.
 */
export async function GET() {
  try {
    const payload = await loadQuotesPayload();
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[api/market/quotes]", err);
    return NextResponse.json(
      { error: "Không tải được dữ liệu bảng giá." },
      { status: 500 }
    );
  }
}
