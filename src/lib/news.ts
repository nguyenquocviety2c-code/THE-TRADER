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
  /** F-210 (audit 19-b): số giây còn chờ khi đánh 429 — cho header Retry-After. */
  retryAfterSeconds?: number;
}

/** Guard rate-limit trong bộ nhớ (một process Next.js duy nhất). */
let lastIngestAt = 0;

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  processEntities: true,
});

// F-108 (audit 19-b): parser riêng cho Atom — phải giữ attribute để đọc
// <link href="..." rel="alternate"/> (parser phía trên bỏ attribute nên
// Atom item mất href → bị bỏ qua). Parser RSS giữ nguyên để 5 feed chạy tốt.
const atomParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
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

/** F-108 (audit 19-b): trích href từ một node link (string | object {@_href|href}). */
function linkHref(raw: unknown): string | null {
  if (typeof raw === "string") return raw.startsWith("http") ? raw : null;
  if (raw !== null && typeof raw === "object") {
    const href =
      (raw as Record<string, unknown>)["@_href"] ??
      (raw as Record<string, unknown>).href;
    if (typeof href === "string" && href.startsWith("http")) return href;
  }
  return null;
}

function firstLink(item: Record<string, unknown>): string | null {
  const link = item.link;
  // RSS 2.0: <link> là string thuần
  if (typeof link === "string" && link.startsWith("http")) return link;
  // Atom: <link> là object hoặc mảng object {"@_href", "@_rel"} —
  // ưu tiên rel="alternate" (bản tin gốc) hoặc không có rel, mới tới rel khác
  if (link !== null && typeof link === "object") {
    const list = Array.isArray(link) ? link : [link];
    const alternates = list.filter((l) => {
      const rel =
        (l as Record<string, unknown>)["@_rel"] ??
        (l as Record<string, unknown>).rel;
      return rel === undefined || rel === "alternate";
    });
    for (const l of [...alternates, ...list]) {
      const href = linkHref(l);
      if (href) return href;
    }
  }
  const guid = item.guid;
  if (typeof guid === "string" && guid.startsWith("http")) return guid;
  return null;
}

function parseDate(item: Record<string, unknown>): Date | null {
  const raw =
    item.pubDate ?? item.published ?? item.updated ?? item["dc:date"];
  if (typeof raw === "string" || typeof raw === "number") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2000) return d;
  }
  // AUD-CODE #29: KHÔNG fallback new Date() — tin thiếu ngày không được gán mốc
  // "vừa xong" nhảy lên đầu danh sách; trả null để caller bỏ qua tin này
  return null;
}

function extractItems(xml: string): Record<string, unknown>[] {
  // F-108 (audit 19-b): Atom feed cần parser giữ attribute (atomParser)
  const isAtom = /<feed[\s>]/i.test(xml);
  const doc = (isAtom ? atomParser : parser).parse(xml) as Record<string, unknown>;
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
    // F-107 (audit 19-b): trả mode THẬT từ DB thay vì hardcode "live" —
    // guard không crawl nên không được phép tự xoá nhãn fallback/stale.
    const [total, status] = await Promise.all([
      db.newsItem.count(),
      db.dataSourceStatus.findUnique({
        where: { key: "news" },
        select: { mode: true },
      }),
    ]);
    return {
      added: 0,
      updated: 0,
      total,
      mode: (status?.mode as SourceMode) ?? "fallback",
      feeds: [],
      ingestedAt: new Date(lastIngestAt).toISOString(),
      // F-210 (audit 19-b): đếm ngược còn lại cho client backoff
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((MIN_INGEST_INTERVAL_MS - (now - lastIngestAt)) / 1000)
      ),
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
        if (!publishedAt) continue; // AUD-CODE #29: bỏ tin không có ngày hợp lệ

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
