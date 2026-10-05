import { XMLParser } from "fast-xml-parser";
import { db } from "@/lib/db";
import { markSource, type SourceMode } from "@/lib/sources";

/**
 * S5 — News RSS crawler (DATA_SOURCES.md §4.3).
 * Đã kiểm chứng kết nối từ môi trường này: VnEconomy, CafeF, VNExpress,
 * Tuổi Trẻ, VietnamNet (DanTri trả HTML nên không dùng).
 * Dedupe theo URL; crawl cách nhau ≥ 60s (rate-limit tôn trọng nguồn).
 */

export interface NewsFeedDef {
  name: string;
  url: string;
  category: "market" | "macro";
}

export const NEWS_FEEDS: NewsFeedDef[] = [
  { name: "VnEconomy", url: "https://vneconomy.vn/thi-truong.rss", category: "market" },
  { name: "CafeF", url: "https://cafef.vn/thi-truong-chung-khoan.rss", category: "market" },
  { name: "VNExpress", url: "https://vnexpress.net/rss/kinh-doanh.rss", category: "macro" },
  { name: "Tuổi Trẻ", url: "https://tuoitre.vn/rss/kinh-doanh.rss", category: "macro" },
  { name: "VietnamNet", url: "https://vietnamnet.vn/rss/kinh-doanh.rss", category: "macro" },
];

const MAX_ITEMS_PER_FEED = 10;
const FEED_TIMEOUT_MS = 8_000;
const MIN_INGEST_INTERVAL_MS = 60_000;

export interface FeedResult {
  name: string;
  ok: boolean;
  items: number;
  error?: string;
}

export interface NewsIngestResult {
  added: number;
  updated: number;
  total: number;
  mode: SourceMode;
  feeds: FeedResult[];
  ingestedAt: string;
}

/** Guard rate-limit trong bộ nhớ (một process Next.js duy nhất). */
let lastIngestAt = 0;

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  processEntities: true,
});

/** Strip thẻ HTML + rút gọn phần mô tả. */
function cleanText(raw: unknown, max = 320): string {
  if (typeof raw !== "string") return "";
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
}

function firstLink(item: Record<string, unknown>): string | null {
  const link = item.link;
  if (typeof link === "string" && link.startsWith("http")) return link;
  // Atom: link là mảng object {href}
  if (Array.isArray(link)) {
    for (const l of link) {
      const href = (l as { href?: unknown })?.href;
      if (typeof href === "string" && href.startsWith("http")) return href;
    }
  }
  const guid = item.guid;
  if (typeof guid === "string" && guid.startsWith("http")) return guid;
  return null;
}

function parseDate(item: Record<string, unknown>): Date {
  const raw =
    item.pubDate ?? item.published ?? item.updated ?? item["dc:date"];
  if (typeof raw === "string" || typeof raw === "number") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2000) return d;
  }
  return new Date();
}

function extractItems(xml: string): Record<string, unknown>[] {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const rss = doc.rss as Record<string, unknown> | undefined;
  const channel = (rss?.channel ?? doc.channel) as
    | Record<string, unknown>
    | undefined;
  const rawItems = channel?.item ?? doc.item;
  // RDF (RSS 1.0): item nằm ở cấp gốc
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
  const rdfItems = rdf?.item;
  const atom = doc.feed as Record<string, unknown> | undefined;
  const atomEntries = atom?.entry;

  const list = Array.isArray(rawItems)
    ? rawItems
    : rawItems
      ? [rawItems]
      : Array.isArray(rdfItems)
        ? rdfItems
        : Array.isArray(atomEntries)
          ? atomEntries
          : [];
  return list.filter(
    (i): i is Record<string, unknown> => typeof i === "object" && i !== null
  );
}

export async function ingestNews(): Promise<NewsIngestResult> {
  const now = Date.now();
  if (now - lastIngestAt < MIN_INGEST_INTERVAL_MS) {
    const [total] = await Promise.all([db.newsItem.count()]);
    return {
      added: 0,
      updated: 0,
      total,
      mode: "live",
      feeds: [],
      ingestedAt: new Date(lastIngestAt).toISOString(),
    };
  }
  lastIngestAt = now;

  const feeds: FeedResult[] = [];
  let added = 0;
  let updated = 0;

  for (const feed of NEWS_FEEDS) {
    try {
      const res = await fetch(feed.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; TheTraderBot/1.0; +https://thetrader.vn)",
          Accept: "application/rss+xml, application/xml, text/xml, */*",
        },
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        redirect: "follow",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = extractItems(xml).slice(0, MAX_ITEMS_PER_FEED);

      for (const item of items) {
        const title = cleanText(item.title, 200);
        const url = firstLink(item);
        if (!title || !url) continue;
        const summary = cleanText(item.description, 320);
        const publishedAt = parseDate(item);

        const existing = await db.newsItem.findUnique({ where: { url } });
        if (existing) {
          if (summary && summary !== existing.summary) {
            await db.newsItem.update({
              where: { url },
              data: { summary, fetchedAt: new Date() },
            });
            updated++;
          }
          continue;
        }
        await db.newsItem.create({
          data: {
            title,
            summary: summary || null,
            url,
            source: feed.name,
            sourceUrl: feed.url,
            category: feed.category,
            publishedAt,
          },
        });
        added++;
      }
      feeds.push({ name: feed.name, ok: true, items: items.length });
    } catch (err) {
      feeds.push({
        name: feed.name,
        ok: false,
        items: 0,
        error: err instanceof Error ? err.message : "Lỗi không xác định",
      });
    }
  }

  const anyOk = feeds.some((f) => f.ok && f.items > 0);
  const mode: SourceMode = anyOk ? "live" : "fallback";
  const okNames = feeds.filter((f) => f.ok).map((f) => f.name);

  await markSource("news", {
    mode,
    success: anyOk,
    lastError: anyOk ? null : feeds.map((f) => `${f.name}: ${f.error}`).join("; "),
    meta: {
      providers: okNames,
      feeds: feeds.map((f) => ({ name: f.name, ok: f.ok, items: f.items })),
      lastAdded: added,
    },
  });

  await db.auditLog.create({
    data: {
      action: "NEWS_INGESTED",
      entity: "NewsItem",
      after: JSON.stringify({
        added,
        updated,
        mode,
        feeds: feeds.map((f) => ({ name: f.name, ok: f.ok, items: f.items })),
      }),
    },
  });

  return {
    added,
    updated,
    total: await db.newsItem.count(),
    mode,
    feeds,
    ingestedAt: new Date().toISOString(),
  };
}

/** 10 tin mới nhất cho prompt agent + UI. */
export async function latestNewsForContext(limit = 10) {
  return db.newsItem.findMany({
    orderBy: { publishedAt: "desc" },
    take: limit,
    select: { title: true, summary: true, source: true, publishedAt: true, category: true },
  });
}
