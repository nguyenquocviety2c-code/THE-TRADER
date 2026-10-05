import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

/** Mask a broker account number for API responses (PII policy, blueprint §6). */
function maskAccount(accountNumber: string): string {
  if (accountNumber.length <= 8) return accountNumber.replace(/.(?=.{2})/g, "•");
  const head = accountNumber.slice(0, 4);
  const tail = accountNumber.slice(-4);
  const masked = "•".repeat(Math.max(0, accountNumber.length - 8));
  return `${head}${masked}${tail}`;
}

export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio
 * Broker account + open positions with live P&L and totals.
 */
export async function GET() {
  try {
    const account = await db.brokerAccount.findFirst({
      where: { deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: {
        positions: {
          where: { status: "OPEN" },
          include: {
            instrument: {
              include: {
                quotes: { orderBy: { tradedAt: "desc" }, take: 1 },
              },
            },
          },
        },
      },
    });

    if (!account) {
      return NextResponse.json(
        { error: "Không tìm thấy tài khoản môi giới." },
        { status: 404 }
      );
    }

    const positions = account.positions
      .map((p) => {
        const q = p.instrument.quotes[0];
        const last = q?.last ?? p.avgPrice;
        const marketValue = p.quantity * last;
        const costBasis = p.quantity * p.avgPrice;
        const unrealizedPnl = marketValue - costBasis;
        return {
          symbol: p.instrument.symbol,
          name: p.instrument.name,
          sector: p.instrument.sector ?? "",
          quantity: p.quantity,
          avgPrice: p.avgPrice,
          last,
          refPrice: q?.refPrice ?? null,
          changePct: q?.changePct ?? 0,
          marketValue,
          costBasis,
          unrealizedPnl,
          unrealizedPnlPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
          realizedPnl: p.realizedPnl,
        };
      })
      .sort((a, b) => b.marketValue - a.marketValue);

    const totalMarketValue = positions.reduce((s, p) => s + p.marketValue, 0);
    const totalCostBasis = positions.reduce((s, p) => s + p.costBasis, 0);
    const totalUnrealizedPnl = totalMarketValue - totalCostBasis;
    const totalRealizedPnl = positions.reduce((s, p) => s + Number(p.realizedPnl), 0);

    // Day change weighted by current market value
    const dayChangePct =
      totalMarketValue > 0
        ? positions.reduce((s, p) => s + p.marketValue * (p.changePct / 100), 0) /
          totalMarketValue *
          100
        : 0;

    return NextResponse.json(
      toPlain({
        account: {
          broker: account.broker,
          accountNumber: maskAccount(account.accountNumber),
          accountType: account.accountType,
          cashBalance: account.cashBalance,
          equity: account.equity,
          marginUsed: account.marginUsed,
          currency: account.currency,
          status: account.status,
        },
        positions,
        totals: {
          totalMarketValue,
          totalCostBasis,
          totalUnrealizedPnl,
          totalUnrealizedPnlPct:
            totalCostBasis > 0 ? (totalUnrealizedPnl / totalCostBasis) * 100 : 0,
          totalRealizedPnl,
          totalEquity: Number(account.cashBalance) + totalMarketValue,
          dayChangePct,
        },
      })
    );
  } catch (err) {
    console.error("[api/portfolio]", err);
    return NextResponse.json(
      { error: "Không tải được dữ liệu danh mục." },
      { status: 500 }
    );
  }
}
