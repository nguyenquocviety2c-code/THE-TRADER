import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestNews } from "@/lib/news";
import { readSources, staleOf } from "@/lib/sources";

export const dynamic = "force-dynamic";

/**
 * GET  /api/news?limit=12 — tin mới nhất (S5) + meta nguồn (stale marking).
 * POST /api/news — chạy crawler RSS ngay (rate-limit 60s giữa 2 lần nạp).
 */
export async function GET(req: NextRequest) {
  try {
    const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? 12);
    const limit = Math.min(
      30,
      Math.max(1, Number.isFinite(limitParam) ? limitParam : 12)
    );

    const [items, sources, total] = await Promise.all([
      db.newsItem.findMany({
        orderBy: { publishedAt: "desc" },
        take: limit,
        select: {
          id: true,
          title: true,
          summary: true,
          url: true,
          source: true,
          category: true,
          publishedAt: true,
          fetchedAt: true,
        },
      }),
      readSources(),
      db.newsItem.count(),
    ]);
    const newsSource = sources.find((s) => s.key === "news");
    const stale = newsSource
      ? staleOf(newsSource)
      : { stale: false, ageMinutes: null };

    return NextResponse.json({
      items,
      meta: {
        total,
        mode: newsSource?.mode ?? "fallback",
        lastSuccessAt: newsSource?.lastSuccessAt?.toISOString() ?? null,
        stale: stale.stale,
        ageMinutes: stale.ageMinutes,
        providers: (newsSource?.meta?.providers as string[] | undefined) ?? [],
      },
    });
  } catch (err) {
    console.error("[api/news GET]", err);
    return NextResponse.json(
      { error: "Không tải được tin tức." },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    const result = await ingestNews();
    if (result.feeds.length === 0) {
      return NextResponse.json(
        {
          error: "Vừa nạp tin cách đây dưới 60 giây — vui lòng đợi chút.",
          ...result,
        },
        { status: 429 }
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/news POST]", err);
    return NextResponse.json(
      { error: "Nạp tin tức thất bại. Vui lòng thử lại." },
      { status: 500 }
    );
  }
}
