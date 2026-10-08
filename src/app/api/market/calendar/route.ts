import { NextRequest, NextResponse } from "next/server";
import {
  officialCalendarView,
  upcomingHolidays,
} from "@/lib/vn-calendar";

export const dynamic = "force-dynamic";

/**
 * P2-4 (phiên #62) — GET /api/market/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 * &days=60: lịch giao dịch VN CHÍNH THỨC (lớp tĩnh market-session.ts 2026-2027
 * + overlay AppSetting "vn-holidays") — ngày nào có phiên, ngày nào nghỉ vì
 * lễ gì, nguồn static/overlay. Ngày sai định dạng → 400 (đồng bộ F-611-03).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const sp = req.nextUrl.searchParams;
    // F-63C-09/#63 — round-trip bắt ngày roll-over ("2026-02-31" → 03-03):
    // trước fix route trả 200 kèm days bắt đầu lệch 2 ngày (echo sai dữ liệu)
    const isoOk = (s: string): boolean => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
      const t = new Date(`${s}T00:00:00Z`).getTime();
      return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
    };
    const todayIso = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    const from = sp.get("from") ?? todayIso;
    if (!isoOk(from)) {
      return NextResponse.json(
        { error: "Tham số from phải là ngày ISO YYYY-MM-DD hợp lệ." },
        { status: 400 }
      );
    }
    const daysParam = Number(sp.get("days") ?? 60);
    const daysCount = Math.min(400, Math.max(1, Number.isFinite(daysParam) ? daysParam : 60));
    const to = sp.get("to");
    let toIso: string;
    if (to != null) {
      if (!isoOk(to)) {
        return NextResponse.json(
          { error: "Tham số to phải là ngày ISO YYYY-MM-DD hợp lệ." },
          { status: 400 }
        );
      }
      toIso = to;
    } else {
      toIso = new Date(new Date(`${from}T00:00:00Z`).getTime() + (daysCount - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
    }

    const [{ days, overlay }, upcoming] = await Promise.all([
      officialCalendarView(from, toIso),
      upcomingHolidays(6),
    ]);
    return NextResponse.json({
      from,
      to: toIso,
      tradingDayCount: days.filter((d) => d.trading).length,
      days,
      overlay,
      upcoming,
      source: "market-session.ts (tĩnh 2026 chính thức + 2027 ước lượng) + AppSetting vn-holidays (overlay runtime)",
    });
  } catch (err) {
    console.error("[api/market/calendar GET]", err);
    return NextResponse.json(
      { error: "Không dựng được lịch giao dịch." },
      { status: 500 }
    );
  }
}
