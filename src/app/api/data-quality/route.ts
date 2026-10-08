import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/data-quality (P1-7 — DATA_PLATFORM_BLUEPRINT v1.3 §5) — lịch sử
 * verdict chất lượng dữ liệu từ bảng DataQualityReport (asOf DESC index —
 * truy vấn < 100ms, test 8 mở rộng).
 *
 * Query (tuỳ chọn):
 *   ?limit=30          — số dòng mới nhất (1..200, mặc định 30)
 *   ?from=YYYY-MM-DD   — lọc asOf >= from (cùng to thì tính trend)
 *   ?to=YYYY-MM-DD     — lọc asOf <= to
 *
 * Response: { ok, latest, history[], trend: { PASS, DEGRADED, SEVERE, total },
 * queryMs } — trend đếm theo level trong cửa sổ from..to (hoặc toàn bộ khi
 * không truyền). AgentRun.output của A9 vẫn ghi verdict song song (S1/
 * extractVerdict đọc như cũ) — bảng này phục vụ lịch sử dài/trend.
 */
export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") ?? 30) || 30));
    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to");

    // F-611-03/#61 — regex đúng dạng NHƯNG ngày không tồn tại (2026-13-99)
    // cho Invalid Date → Prisma throw → 500 "db" (đã verify live). Lỗi nhập
    // của client phải là 400, không được ngụy trang thành lỗi DB.
    const parseDate = (raw: string | null, endOfDay: boolean): Date | null => {
      if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
      const d = new Date(`${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
      if (Number.isNaN(d.getTime())) {
        throw new DateParamError(raw);
      }
      return d;
    };

    const asOf: { gte?: Date; lte?: Date } = {};
    asOf.gte = parseDate(fromRaw, false) ?? undefined;
    asOf.lte = parseDate(toRaw, true) ?? undefined;
    const where = Object.keys(asOf).length > 0 ? { asOf } : {};

    const [rows, counts] = await Promise.all([
      db.dataQualityReport.findMany({
        where,
        orderBy: { asOf: "desc" },
        take: limit,
      }),
      db.dataQualityReport.groupBy({
        by: ["level"],
        where,
        _count: { level: true },
      }),
    ]);

    // F-611-09/#61 — total = TỔNG MỌI level gặp (trước đây chỉ cộng 3 level
    // đã biết — level lạ bị loại khỏi total âm thầm; ngày nay writer là union
    // DqLevel nên không reachable, nhưng route không được giả định).
    const trend: Record<string, number> = { PASS: 0, DEGRADED: 0, SEVERE: 0 };
    let trendTotal = 0;
    for (const c of counts) {
      trend[c.level] = c._count.level;
      trendTotal += c._count.level;
    }

    const parse = (raw: string | null) => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const history = rows.map((r) => ({
      id: r.id,
      asOf: r.asOf,
      level: r.level,
      checks: parse(r.checks),
      summary: parse(r.summary),
      createdAt: r.createdAt,
    }));

    return NextResponse.json(
      toPlain({
        ok: true,
        latest: history[0] ?? null,
        history,
        trend: { ...trend, total: trendTotal },
        queryMs: Date.now() - startedAt,
      })
    );
  } catch (err) {
    // F-611-03/#61 — lỗi tham số ngày → 400 (không phải 500 "db")
    if (err instanceof DateParamError) {
      return NextResponse.json(
        { ok: false, error: `Tham số ngày "${err.raw}" không hợp lệ (dùng YYYY-MM-DD, ví dụ 2026-10-08).` },
        { status: 400 }
      );
    }
    console.error("[api/data-quality] GET lỗi:", err);
    return NextResponse.json({ ok: false, error: "db" }, { status: 500 });
  }
}

class DateParamError extends Error {
  constructor(public raw: string) {
    super(`invalid date param: ${raw}`);
  }
}
