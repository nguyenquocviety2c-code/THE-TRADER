/**
 * src/lib/vndirect.ts — VNDIRECT CUSTOMER API client (Tier 2 —
 * DATA_SOURCES.md §3.2, Phiên #34 Settings module).
 *
 * Hai lớp API VNDIRECT:
 *  (a) PUBLIC không cần auth — dchart-api (EOD, đã dùng ở eod-sync.ts) và
 *      finfo-api.vndirect.com.vn (quote realtime / lastprice);
 *  (b) CUSTOMER — OAuth2 client_credentials tại auth.vndirect.com.vn với
 *      consumer key/secret (lấy từ portal VNDIRECT) → access token dùng cho
 *      API realtime/đăng lệnh.
 *
 * PROBE THỰC ĐO (sandbox, 2026-10): finfo-api.vndirect.com.vn resolve DNS
 * (kể cả qua DoH Google/Cloudflare) về 10.210.100.8 — địa chỉ RFC1918 private
 * nên KHÔNG kết nối được từ sandbox (curl HTTP 000, timeout 10s ở cả 3 hình
 * thức POST /v4/lastprice, GET /v4/lastprice, GET /v4/stock_prices).
 * auth.vndirect.com.vn → NXDOMAIN (chưa publish public). Chỉ dchart-api
 * (160.250.74.45) là sống. Do đó client này được viết theo tài liệu/spec và
 * sẽ hoạt động khi chạy trên máy chủ có egress tới VNDIRECT (hoặc khi VNDIRECT
 * whitelist). Mọi lỗi network/parse trả {ok:false, message tiếng Việt}.
 *
 * ĐƠN VỊ GIÁ: finfo v4 trả giá theo NGHÌN VND giống dchart (VCB 57.3 =
 * 57.300₫) trên đa số endpoint đã quan sát; một số endpoint v4 trả VND nguyên.
 * Không đối chiếu trực tiếp được từ sandbox nên dùng heuristic magnitude ở
 * normalizePrice(): VN30 không có mã dưới ~10.000₫ → raw < 1.000 chắc chắn là
 * nghìn VND (×1000), raw ≥ 1.000 coi như VND nguyên.
 */

import type { SettingsTestResponse } from "@/lib/types";

export interface VndirectCreds {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accountNumber: string;
}

/** Base URL finfo (public quotes) — override được qua env cho môi trường proxy. */
export const FINFO_BASE =
  process.env.FINFO_BASE_URL ?? "https://finfo-api.vndirect.com.vn";

/** OAuth2 token endpoint VNDIRECT (customer API). */
export const VNDIRECT_AUTH_URL =
  process.env.VNDIRECT_AUTH_URL ?? "https://auth.vndirect.com.vn/auth/oauth/token";

/** Scope customer theo tài liệu VNDIRECT Open API. */
const VNDIRECT_AUTH_SCOPE = "vndirect:customer";

/** Cột finfo cần cho quote realtime (đơn giá cuối + KLGD dồn phiên). */
const FINFO_COLUMNS = ["code", "closePrice", "adClosePrice", "percentChange", "accumulatedVol"];

export interface FinfoQuote {
  symbol: string;
  /** Giá cuối — ĐÃ chuẩn hoá về VND nguyên (×1000 nếu finfo trả nghìn VND). */
  last: number;
  changePct: number;
  /** KLGD dồn phiên (cổ phiếu) — undefined khi finfo không trả. */
  volume?: number;
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "hết thời gian chờ (timeout)";
    }
    return err.message;
  }
  return String(err);
}

/** Heuristic network-error (để gợi ý whitelist egress trong thông báo test). */
function looksLikeNetworkError(message: string): boolean {
  return /timeout|hết thời gian|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|fetch failed|kết nối/i.test(
    message
  );
}

/**
 * Chuẩn hoá đơn vị giá finfo → VND nguyên.
 * finfo v4 đa số trả NGHÌN VND (như dchart: VCB 57.3 = 57.300₫); một số
 * endpoint trả VND nguyên. VN30 không có mã dưới ~10.000₫ nên raw < 1.000
 * chắc chắn là nghìn VND → ×1000; ngược lại dùng nguyên.
 */
function normalizePrice(raw: number): number {
  return raw < 1_000 ? raw * 1_000 : raw;
}

/* ─────────────────────────── OAuth2 customer ─────────────────────────── */

/**
 * Lấy access token OAuth2 client_credentials từ auth.vndirect.com.vn.
 * Body form-urlencoded: grant_type + consumer_key + consumer_secret + scope.
 * Parse {access_token, token_type, expires_in?} hoặc {error, error_description}.
 */
export async function getVndirectToken(
  consumerKey: string,
  consumerSecret: string,
  timeoutMs = 10_000
): Promise<{ ok: boolean; token?: string; message?: string }> {
  const startedAt = Date.now();
  try {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      consumer_key: consumerKey,
      consumer_secret: consumerSecret,
      scope: VNDIRECT_AUTH_SCOPE,
    });
    const res = await fetch(VNDIRECT_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const text = await res.text().catch(() => "");
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (res.ok && json && typeof json.access_token === "string" && json.access_token) {
      const expiresIn = typeof json.expires_in === "number" ? json.expires_in : null;
      return {
        ok: true,
        token: json.access_token,
        message: `OAuth2 thành công (HTTP ${res.status}, ${Date.now() - startedAt}ms${
          expiresIn ? `, hết hạn sau ${Math.round(expiresIn / 60)} phút` : ""
        })`,
      };
    }
    if (json && typeof json.error === "string") {
      const desc = typeof json.error_description === "string" ? ` — ${json.error_description}` : "";
      return { ok: false, message: `OAuth2 bị từ chối: ${json.error}${desc}` };
    }
    return {
      ok: false,
      message: `OAuth2 thất bại (HTTP ${res.status})${text ? `: ${text.slice(0, 160)}` : " — phản hồi rỗng"}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Không kết nối được ${VNDIRECT_AUTH_URL}: ${errText(err)}`,
    };
  }
}

/* ─────────────────────────── finfo lastprice ─────────────────────────── */

/** Trích mảng dòng báo giá từ envelope finfo v4 ({data:[...]} hoặc mảng trần). */
function extractRows(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)) {
    return (json as { data: Record<string, unknown>[] }).data;
  }
  return [];
}

function parseFinfoRows(rows: Record<string, unknown>[]): FinfoQuote[] {
  const quotes: FinfoQuote[] = [];
  for (const row of rows) {
    const symbol = String(row.code ?? row.symbol ?? "").trim().toUpperCase();
    if (!symbol) continue;
    const rawPrice = Number(row.closePrice ?? row.adClosePrice);
    if (!Number.isFinite(rawPrice) || rawPrice <= 0) continue; // null → bỏ qua mã
    const changePctRaw = Number(row.percentChange);
    const volRaw = Number(row.accumulatedVol);
    quotes.push({
      symbol,
      last: normalizePrice(rawPrice),
      changePct: Number.isFinite(changePctRaw) ? changePctRaw : 0,
      volume: Number.isFinite(volRaw) && volRaw >= 0 ? Math.round(volRaw) : undefined,
    });
  }
  return quotes;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Lấy last price realtime từ finfo v4 (PUBLIC — Bearer token chỉ gắn thêm nếu
 * có, finfo trả giá công khai không bắt buộc auth).
 *
 * Hình thức chính: POST /v4/lastprice body {"data":{"q":"code:VCB,TCB",
 * "columns":[...]}} — dạng web terminal vndirect.com.vn dùng. Nếu server từ
 * chối POST (HTTP lỗi) hoặc trả 0 dòng, thử GET /v4/lastprice?q=...&columns=...
 * Lỗi mạng/DNS/timeout → fail ngay (không retry mù trong 1 lần gọi).
 */
export async function fetchFinfoLastPrices(
  symbols: string[],
  accessToken?: string,
  timeoutMs = 10_000
): Promise<{ ok: boolean; quotes: FinfoQuote[]; message?: string }> {
  const clean = symbols
    .map((s) => String(s ?? "").trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 60);
  if (clean.length === 0) {
    return { ok: false, quotes: [], message: "Danh sách mã trống — không gọi finfo." };
  }
  const q = `code:${clean.join(",")}`;
  const authHeaders: Record<string, string> = {
    accept: "application/json",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };

  try {
    // ── Hình thức 1: POST {"data":{q, columns}} ──
    const post = await fetchJson(
      `${FINFO_BASE}/v4/lastprice`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ data: { q, columns: FINFO_COLUMNS } }),
      },
      timeoutMs
    );
    if (post.ok) {
      const quotes = parseFinfoRows(extractRows(post.json));
      if (quotes.length > 0) {
        return { ok: true, quotes, message: `finfo trả ${quotes.length}/${clean.length} mã` };
      }
    }

    // ── Hình thức 2 (fallback): GET /v4/lastprice?q=...&columns=... ──
    // Chỉ thử khi POST có HTTP response (lỗi cấu hình/shape) hoặc trả 0 dòng.
    const getUrl =
      `${FINFO_BASE}/v4/lastprice?q=${encodeURIComponent(q)}` +
      `&columns=${encodeURIComponent(FINFO_COLUMNS.join(","))}`;
    const get = await fetchJson(getUrl, { method: "GET", headers: authHeaders }, timeoutMs);
    if (get.ok) {
      const quotes = parseFinfoRows(extractRows(get.json));
      if (quotes.length > 0) {
        return { ok: true, quotes, message: `finfo (GET) trả ${quotes.length}/${clean.length} mã` };
      }
      return {
        ok: false,
        quotes: [],
        message: "finfo phản hồi 200 nhưng không có dòng giá nào — kiểm tra danh sách mã.",
      };
    }
    return {
      ok: false,
      quotes: [],
      message: `finfo HTTP ${get.status}${get.text ? `: ${get.text.slice(0, 160)}` : ""}`,
    };
  } catch (err) {
    return {
      ok: false,
      quotes: [],
      message: `Không gọi được ${FINFO_BASE}: ${errText(err)}`,
    };
  }
}

/* ─────────────────────────── Test kết nối ─────────────────────────── */

/**
 * Test đầy đủ kết nối VNDIRECT cho nút "Kiểm tra kết nối" trong module Cài
 * đặt: (1) OAuth2 consumer key/secret nếu nhập đủ; (2) finfo lastprice VCB
 * (dùng access token nhập tay hoặc token vừa cấp). ok = finfoOk (auth là
 * tùy chọn — finfo công khai vẫn đủ chạy realtime quote).
 */
export async function testVndirect(creds: VndirectCreds): Promise<SettingsTestResponse> {
  const startedAt = Date.now();

  const authTried = Boolean(creds.consumerKey?.trim() && creds.consumerSecret?.trim());
  let authOk = false;
  let authMessage: string | null = null;
  let token: string | undefined;
  if (authTried) {
    const auth = await getVndirectToken(creds.consumerKey.trim(), creds.consumerSecret.trim());
    authOk = auth.ok;
    authMessage = auth.ok ? (auth.message ?? "OAuth2 thành công") : (auth.message ?? "OAuth2 thất bại");
    token = auth.token;
  }

  const effectiveToken = creds.accessToken?.trim() ? creds.accessToken.trim() : token;
  const finfo = await fetchFinfoLastPrices(["VCB"], effectiveToken);
  const finfoOk = finfo.ok;
  const finfoMessage = finfo.ok
    ? (finfo.message ?? "finfo hoạt động")
    : (finfo.message ?? "finfo thất bại");
  const first = finfo.quotes[0] ?? null;

  const latencyMs = Date.now() - startedAt;

  const parts: string[] = [];
  if (authTried) {
    parts.push(authOk ? "OAuth2 xác thực thành công" : `OAuth2 thất bại (${authMessage})`);
  }
  parts.push(
    finfoOk
      ? `finfo realtime OK — VCB ${first ? first.last.toLocaleString("vi-VN") + "₫" : "có giá"}`
      : `finfo realtime thất bại: ${finfoMessage}`
  );

  let message: string;
  if (finfoOk && (!authTried || authOk)) {
    message =
      `Kết nối VNDIRECT thành công (${latencyMs}ms) — ${parts.join("; ")}.` +
      (authTried
        ? " Sẵn sàng bật chế độ realtime-vndirect."
        : " finfo public trả giá mà không cần OAuth — có thể bật realtime-vndirect (đăng lệnh thật cần consumer key/secret).");
  } else if (finfoOk) {
    message =
      `finfo công khai hoạt động nhưng OAuth2 khách hàng thất bại (${latencyMs}ms) — ${authMessage ?? ""}. Quote realtime vẫn dùng được.`;
  } else {
    message = `Không kết nối được VNDIRECT (${latencyMs}ms) — ${parts.join("; ")}.`;
    if (
      (finfoMessage && looksLikeNetworkError(finfoMessage)) ||
      (authMessage && looksLikeNetworkError(authMessage))
    ) {
      message +=
        " Lỗi mang tính mạng: sandbox chặn egress tới finfo-api.vndirect.com.vn (DNS → 10.210.100.8) — cần chạy trên máy chủ có egress tới VNDIRECT hoặc whitelist.";
    }
  }

  return {
    ok: finfoOk,
    message,
    details: {
      authTried,
      authOk,
      authMessage,
      finfoOk,
      finfoMessage,
      latencyMs,
      sampleQuote: first ? { symbol: first.symbol, last: first.last, changePct: first.changePct } : null,
    },
  };
}
