import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { markSource } from "@/lib/sources";
import { loadQuotesPayload } from "@/lib/market-quotes";
import { shouldGenerateTicks, sessionPhase, SESSION_PHASE_LABEL } from "@/lib/market-session";

export const dynamic = "force-dynamic";

/**
 * POST /api/market/tick — S4 market-data engine tick (DATA_SOURCES.md §4.2).
 *
 * Trong môi trường demo (không có feed HOSE/HNX realtime), mỗi tick thực hiện
 * random-walk có giới hạn trên quote mới nhất của từng mã, tuân thủ toàn bộ
 * data-quality rules §5:
 *   Q1 — giá làm tròn bội 100 VND
 *   Q2 — luôn nằm trong dải [floorPrice, ceilingPrice] ±7% HOSE
 *   Q3 — khối lượng chỉ tăng (không âm)
 *   Q5 — change = last − refPrice; changePct = change/refPrice × 100
 * Nguồn được đánh dấu mode="simulated" trong DataSourceStatus (không giả mạo
 * "live"). WebSocket mini-service gọi endpoint này định kỳ và broadcast.
 */

const TICK_DRIFT = 0.004; // ±0.4% mỗi tick

function round100(v: number): number {
  return Math.max(100, Math.round(v / 100) * 100);
}

function jitter(depth: number | null): number | null {
  if (depth == null) return null;
  return Math.max(0, Math.round(depth * (0.92 + Math.random() * 0.16)));
}

export async function POST() {
  try {
    if (!shouldGenerateTicks()) {
      const payload = await loadQuotesPayload();
      return NextResponse.json({
        ...payload,
        skipped: true,
        reason: `Ngoài phiên giao dịch (${SESSION_PHASE_LABEL[sessionPhase(new Date())]}) — MARKET_STRICT_SESSION=true`,
      });
    }

    const instruments = await db.instrument.findMany({
      where: { isActive: true },
      select: {
        id: true,
        symbol: true,
        quotes: {
          orderBy: { tradedAt: "desc" },
          take: 1,
          select: {
            id: true,
            open: true,
            high: true,
            low: true,
            last: true,
            volume: true,
            refPrice: true,
            ceilingPrice: true,
            floorPrice: true,
            bidPrice: true,
            askPrice: true,
            bidVolume: true,
            askVolume: true,
          },
        },
      },
    });

    const now = new Date();
    let ticked = 0;

    for (const inst of instruments) {
      const q = inst.quotes[0];
      if (!q || q.last <= 0) continue;

      const ref = q.refPrice ?? q.last;
      const floor = q.floorPrice ?? Math.round(ref * 0.93);
      const ceiling = q.ceilingPrice ?? Math.round(ref * 1.07);

      // Random-walk + mean-reversion nhẹ về giá tham chiếu (giữ giá dao động
      // quanh biên độ hợp lý khi simulator chạy nhiều giờ liền)
      const meanPull = ref > 0 ? ((ref - q.last) / ref) * 0.03 : 0;
      const drift = meanPull + (Math.random() * 2 - 1) * TICK_DRIFT;
      let next = q.last * (1 + drift);
      next = Math.min(Math.max(next, floor), ceiling);
      next = round100(next);

      const change = next - ref;
      const changePct = ref > 0 ? Number(((change / ref) * 100).toFixed(2)) : 0;

      const volAdd = Math.round(
        (500 + Math.random() * 9_500) * (q.volume > 1_000_000 ? 10 : 1)
      );

      const spread = Math.max(100, round100(next * 0.001));
      const bidPrice = Math.max(floor, next - spread);
      const askPrice = Math.min(ceiling, next + spread);

      await db.quote.update({
        where: { id: q.id },
        data: {
          last: next,
          high: Math.max(q.high, next),
          low: Math.min(q.low, next),
          change,
          changePct,
          volume: q.volume + volAdd,
          bidPrice,
          askPrice,
          bidVolume: jitter(q.bidVolume),
          askVolume: jitter(q.askVolume),
          tradedAt: now,
        },
      });
      ticked++;
    }

    await markSource("market-quotes", {
      mode: "simulated",
      success: true,
      meta: {
        ticked,
        engine: "random-walk",
        band: "±7%",
        strictSession: process.env.MARKET_STRICT_SESSION === "true",
      },
    });

    const payload = await loadQuotesPayload();
    return NextResponse.json({ ...payload, ticked });
  } catch (err) {
    console.error("[api/market/tick]", err);
    return NextResponse.json(
      { error: "Tick bảng giá thất bại." },
      { status: 500 }
    );
  }
}
