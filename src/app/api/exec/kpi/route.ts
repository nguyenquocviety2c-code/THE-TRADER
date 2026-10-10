import { NextResponse } from "next/server";
import { computeExecKpi } from "@/lib/exec/kpi";

export const dynamic = "force-dynamic";

/**
 * GET /api/exec/kpi — KPI vận hành nhóm Điều hành & Thực thi (E-P0-5,
 * EXECUTION_OPS_BLUEPRINT v1.1 §4): funnel tín hiệu→duyệt→lệnh→khớp 30 ngày
 * + churn (EXPIRED chưa duyệt) + AOV + phân bố slippage [DA tr1/D5/D10].
 * Query `?days=N` (7..90, mặc định 30).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const daysRaw = Number(url.searchParams.get("days") ?? 30);
    const days = Number.isFinite(daysRaw) && daysRaw >= 7 && daysRaw <= 90 ? Math.round(daysRaw) : 30;
    const kpi = await computeExecKpi(days);
    return NextResponse.json(kpi);
  } catch (err) {
    console.error("[api/exec/kpi]", err);
    return NextResponse.json(
      { error: "Không tính được KPI vận hành nhóm executive." },
      { status: 500 }
    );
  }
}
