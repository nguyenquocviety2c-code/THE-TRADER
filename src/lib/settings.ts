/**
 * src/lib/settings.ts — Settings module persistence (Phiên #34).
 *
 * Lưu qua bảng AppSetting (key unique — value JSON string):
 *  - key "vndirect":    VndirectCreds + lastTestAt/lastTestOk/lastTestMessage
 *  - key "market-data": { mode: MarketDataMode, realtimeOk?: boolean|null,
 *                         lastRealtimeAt?: string|null }
 *
 * Quy ước PATCH (PUT /api/settings): omit = giữ nguyên; chuỗi rỗng "" = xoá
 * sạch field đó. Giá trị chứa marker mask "····" (UI echo lại giá trị đã
 * masked) bị bỏ qua như omit — chống ghi đè secret bằng chuỗi che.
 *
 * getMarketDataMode() có cache in-process 5 giây (tick gọi liên tục 10s/lần)
 * — invalidate khi setMarketDataMode(). Mọi đọc DB fail → fallback env
 * MARKET_DATA_MODE (default "real-eod") — tick không bao giờ crash vì DB.
 */

import { db } from "@/lib/db";
import type { MarketDataMode, UpdateSettingsPayload } from "@/lib/types";
import type { VndirectCreds } from "@/lib/vndirect";

const KEY_VNDIRECT = "vndirect";
const KEY_MARKET_DATA = "market-data";

const MARKET_DATA_MODES: readonly MarketDataMode[] = [
  "real-eod",
  "realtime-vndirect",
  "simulated",
];

/** Marker mask do GET /api/settings trả về — PUT gửi lại thì coi như omit. */
const MASK_MARKER = "····";

export function isMarketDataMode(v: unknown): v is MarketDataMode {
  return typeof v === "string" && (MARKET_DATA_MODES as readonly string[]).includes(v);
}

/** Mode từ env — chỉ dùng khi AppSetting chưa có giá trị hợp lệ. */
function envMarketDataMode(): MarketDataMode {
  const raw = process.env.MARKET_DATA_MODE;
  return isMarketDataMode(raw) ? raw : "real-eod";
}

/* ─────────────────────────── AppSetting helpers ─────────────────────────── */

async function readAppSetting(key: string): Promise<Record<string, unknown> | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key } });
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  } catch (err) {
    console.error(`[lib/settings] đọc AppSetting "${key}" thất bại:`, err);
    return null;
  }
}

async function writeAppSetting(key: string, value: Record<string, unknown>): Promise<boolean> {
  try {
    const json = JSON.stringify(value);
    await db.appSetting.upsert({
      where: { key },
      create: { key, value: json },
      update: { value: json },
    });
    return true;
  } catch (err) {
    console.error(`[lib/settings] ghi AppSetting "${key}" thất bại:`, err);
    return false;
  }
}

/* ─────────────────────────── VNDIRECT creds ─────────────────────────── */

export interface VndirectStoredSettings extends VndirectCreds {
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

const EMPTY_VNDIRECT: VndirectStoredSettings = {
  consumerKey: "",
  consumerSecret: "",
  accessToken: "",
  accountNumber: "",
  lastTestAt: null,
  lastTestOk: null,
  lastTestMessage: null,
};

/** Đọc creds VNDIRECT đã lưu (merge default rỗng — không bao giờ throw). */
export async function getVndirectSettings(): Promise<VndirectStoredSettings> {
  const raw = await readAppSetting(KEY_VNDIRECT);
  if (!raw) return { ...EMPTY_VNDIRECT };
  const str = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  return {
    consumerKey: str("consumerKey"),
    consumerSecret: str("consumerSecret"),
    accessToken: str("accessToken"),
    accountNumber: str("accountNumber"),
    lastTestAt: typeof raw.lastTestAt === "string" ? raw.lastTestAt : null,
    lastTestOk: typeof raw.lastTestOk === "boolean" ? raw.lastTestOk : null,
    lastTestMessage: typeof raw.lastTestMessage === "string" ? raw.lastTestMessage : null,
  };
}

/**
 * Patch creds VNDIRECT: omit = giữ nguyên; "" = xoá field đó. Field chứa
 * marker mask "····" bị bỏ qua (UI echo giá trị masked từ GET).
 */
export async function saveVndirectSettings(
  patch: UpdateSettingsPayload["vndirect"]
): Promise<void> {
  if (!patch) return;
  const cur = await getVndirectSettings();
  const next: VndirectStoredSettings = { ...cur };
  const fields = ["consumerKey", "consumerSecret", "accessToken", "accountNumber"] as const;
  let changed = false;
  for (const field of fields) {
    const v = patch[field];
    if (typeof v !== "string") continue; // omit = giữ nguyên
    if (v.includes(MASK_MARKER)) continue; // giá trị masked echo lại → bỏ
    const clean = v.trim();
    if (clean === cur[field]) continue;
    next[field] = clean; // "" = xoá sạch
    changed = true;
  }
  if (changed) await writeAppSetting(KEY_VNDIRECT, { ...next });
}

/** Ghi nhận kết quả test cuối bằng creds ĐÃ LƯU (POST /api/settings/test). */
export async function updateVndirectTestResult(ok: boolean, message: string): Promise<void> {
  const cur = await getVndirectSettings();
  await writeAppSetting(KEY_VNDIRECT, {
    ...cur,
    lastTestAt: new Date().toISOString(),
    lastTestOk: ok,
    lastTestMessage: message,
  });
}

/** Đã nhập đủ credential để chạy realtime chưa: (key && secret) || accessToken. */
export function isVndirectConfigured(s: {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
}): boolean {
  return Boolean(
    (s.consumerKey && s.consumerSecret) || s.accessToken
  );
}

/* ─────────────────────────── Market-data mode ─────────────────────────── */

let modeCache: { value: MarketDataMode; expiresAt: number } | null = null;
const MODE_CACHE_TTL_MS = 5_000;

/**
 * Mode nguồn dữ liệu hiện tại: AppSetting "market-data".mode nếu hợp lệ,
 * ngược lại fallback env MARKET_DATA_MODE (default "real-eod").
 * Cache in-process 5s (tick gọi liên tục 10s/lần → chỉ đụng DB tối đa
 * 1 lần/5s); invalidate khi setMarketDataMode().
 */
export async function getMarketDataMode(): Promise<MarketDataMode> {
  const now = Date.now();
  if (modeCache && modeCache.expiresAt > now) return modeCache.value;
  const raw = await readAppSetting(KEY_MARKET_DATA);
  const mode = isMarketDataMode(raw?.mode) ? raw.mode : envMarketDataMode();
  modeCache = { value: mode, expiresAt: now + MODE_CACHE_TTL_MS };
  return mode;
}

/** Đổi mode runtime (ghi đè env đến khi bị xoá/sửa lại). Invalidate cache. */
export async function setMarketDataMode(mode: MarketDataMode): Promise<void> {
  const raw = (await readAppSetting(KEY_MARKET_DATA)) ?? {};
  await writeAppSetting(KEY_MARKET_DATA, { ...raw, mode });
  modeCache = null;
}

/** Ghi nhận kết quả lần fetch realtime cuối (không đụng mode). */
export async function markRealtimeAttempt(ok: boolean): Promise<void> {
  const raw = (await readAppSetting(KEY_MARKET_DATA)) ?? {};
  await writeAppSetting(KEY_MARKET_DATA, {
    ...raw,
    realtimeOk: ok,
    lastRealtimeAt: new Date().toISOString(),
  });
}

export interface EffectiveModeInfo {
  mode: MarketDataMode;
  /** Mode thực tế sau fallback: realtime-vndirect nhưng chưa configured hoặc
   *  lần fetch cuối thất bại → real-eod (UI hiển thị cảnh báo). */
  effectiveMode: MarketDataMode;
  realtimeOk: boolean | null;
  lastRealtimeAt: string | null;
}

/**
 * Mode hiệu lực: mode = realtime-vndirect chỉ hiệu lực khi ĐÃ configured
 * ((consumerKey && consumerSecret) || accessToken) VÀ lần fetch realtime cuối
 * không thất bại (realtimeOk !== false; null = chưa từng fetch → lạc quan).
 */
export async function getEffectiveMode(): Promise<EffectiveModeInfo> {
  const raw = await readAppSetting(KEY_MARKET_DATA);
  const mode = isMarketDataMode(raw?.mode) ? raw.mode : envMarketDataMode();
  const realtimeOk = typeof raw?.realtimeOk === "boolean" ? raw.realtimeOk : null;
  const lastRealtimeAt = typeof raw?.lastRealtimeAt === "string" ? raw.lastRealtimeAt : null;

  let effectiveMode = mode;
  if (mode === "realtime-vndirect") {
    const vnd = await getVndirectSettings();
    if (!isVndirectConfigured(vnd) || realtimeOk === false) {
      effectiveMode = "real-eod";
    }
  }
  return { mode, effectiveMode, realtimeOk, lastRealtimeAt };
}

/** Bối cảnh realtime cho tick route: mode + active + access token. */
export async function getRealtimeRuntime(): Promise<{
  mode: MarketDataMode;
  active: boolean;
  accessToken: string;
}> {
  const mode = await getMarketDataMode();
  if (mode !== "realtime-vndirect") return { mode, active: false, accessToken: "" };
  const vnd = await getVndirectSettings();
  return { mode, active: isVndirectConfigured(vnd), accessToken: vnd.accessToken };
}

/* ─────────────────────────── Masking ─────────────────────────── */

/**
 * Che secret cho GET /api/settings: "" → ""; ngắn hơn 8 ký tự → "····";
 * ngược lại 4 ký tự đầu + "·"×8 (độ dài cố định — không lộ độ dài thật).
 */
export function maskSecret(v: string): string {
  if (!v) return "";
  if (v.length < 8) return "····";
  return `${v.slice(0, 4)}${"·".repeat(8)}`;
}
