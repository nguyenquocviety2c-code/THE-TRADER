import { NextResponse } from "next/server";
import { toPlain } from "@/lib/serialize";
import { db } from "@/lib/db";
import { computeExecKpi } from "@/lib/exec/kpi";
// E-P1-3 (v1.2): CashflowForecast gộp vào payload KPI (1 request cho khối
// executive — tránh thêm endpoint riêng cho phần hiển thị kèm KPI card).
import { computeCashflowForecast } from "@/lib/exec/forecast";
import { computeCommittedCashView } from "@/lib/exec/committed";

export const dynamic = "force-dynamic";

/**
 * GET /api/exec/kpi — KPI vận hành nhóm Điều hành & Thực thi (E-P0-5,
 * EXECUTION_OPS_BLUEPRINT v1.1 §4): funnel tín hiệu→duyệt→lệnh→khớp 30 ngày
 * + churn (EXPIRED chưa duyệt) + AOV + phân bố slippage [DA tr1/D5/D10].
 * Query `?days=N` (7..90, mặc định 30).
 *
 * E-P1-3 (v1.2): + `forecast` — CashflowForecast kịch bản {none, half,
 * allApprove} + CI 95% quantile từ chuỗi CashSnapshot + CommittedCashView
 * (fail-soft: lỗi forecast → forecast=null, KPI vẫn trả đủ).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const daysRaw = Number(url.searchParams.get("days") ?? 30);
    const days = Number.isFinite(daysRaw) && daysRaw >= 7 && daysRaw <= 90 ? Math.round(daysRaw) : 30;
    const kpi = await computeExecKpi(days);

    // E-P1-3: dự báo dòng tiền kèm KPI — fail-soft riêng (không làm hỏng KPI).
    let forecast: Awaited<ReturnType<typeof computeCashflowForecast>> | null = null;
    try {
      const [account, positions] = await Promise.all([
        db.brokerAccount.findFirst({
          where: { deletedAt: null },
          select: { id: true, cashBalance: true, marginUsed: true },
        }),
        db.position.findMany({
          where: { status: "OPEN" },
          select: {
            quantity: true,
            instrument: {
              select: { quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { last: true } } },
            },
          },
        }),
      ]);
      if (account) {
        // F-102: equity = cash + Σ(qty × last) vị thế mở (equity DB chỉ là
        // snapshot — tính lại đúng công thức như A12 portfolioSnapshot).
        const positionsMv = positions.reduce(
          (s, p) => s + (p.instrument.quotes[0]?.last ?? 0) * p.quantity,
          0
        );
        const view = await computeCommittedCashView({
          cash: Number(account.cashBalance),
          equity: Number(account.cashBalance) + positionsMv,
          marginUsed: Number(account.marginUsed ?? 0),
          buyingPowerFactor: 0.5,
          marginRoomMinVnd: 0,
        });
        forecast = await computeCashflowForecast(
          {
            cash: view.cash,
            committedBuyNotional: view.committedBuyNotional,
            committedSellInflow: view.committedSellInflow,
          },
          account.id
        );
      }
    } catch (fcErr) {
      console.error("[api/exec/kpi:forecast]", fcErr);
    }

    return NextResponse.json(toPlain({ ...kpi, forecast }));
  } catch (err) {
    console.error("[api/exec/kpi]", err);
    return NextResponse.json(
      { error: "Không tính được KPI vận hành nhóm executive." },
      { status: 500 }
    );
  }
}
