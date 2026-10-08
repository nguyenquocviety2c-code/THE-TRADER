/**
 * src/lib/feature-cache.ts — P2-3 CACHE GIÁ TRỊ ĐẶC TRƯNG (phiên #62).
 * DATA_PLATFORM_BLUEPRINT v1.6 §5 P2-3: điều kiện đo #61 DƯƠNG TÍNH
 * (~7-8 chỗ gọi topByAdtv/chu kỳ, mỗi lần 2 query WAN ≈ 100-230ms → tổng
 * ~750-850ms/chu kỳ > ngưỡng 200ms của P0-3). Kỷ luật §6: KHÔNG Redis —
 * cache dùng BẢNG POSTGRES `FeatureValue` + lớp L1 in-process.
 *
 * Hai lớp:
 *   · L1 — Map trong process (Next.js app): hit ~0ms; backfill từ L2 với
 *     thời hạn CÒN LẠI của row L2 (không kéo dài tuổi thọ).
 *   · L2 — bảng Postgres FeatureValue (key unique): dùng khi L1 hết hạn
 *     (1 query ~95ms thay vì recompute 2 query ~200-330ms), warm-start
 *     sau restart process, bằng chứng kiểm định được (row có computedAt).
 *     TTL L2 mặc định 10 PHÚT — đủ bắc nhiều chu kỳ agents liên tiếp.
 *
 * Chi phí thực đo (RTT Supabase ~95-105ms/query từ sandbox):
 *   · Chu kỳ ổn định (L1 hoặc L2 còn hạn): 0-95ms/chu kỳ ✓ < 200ms.
 *   · Recompute (L2 hết hạn 10' / sau invalidation): ~200-330ms MỘT lần
 *     cho cả nhóm chu kỳ — vẫn tốt hơn 750-850ms MỖI chu kỳ trước cache.
 *
 * Invalidation CHỦ ĐỘNG (quan trọng hơn TTL — TTL chỉ là lưới an toàn):
 * mọi đường ghi Bar đều xoá tiền tố "topByAdtv:" — eod-sync (sync + deep
 * backfill) · corporate-events (adjust/reapply/reverse) · tick simulated
 * rollover · reprobe · intl-eod. Bar không đổi → ADTV không đổi → cache đúng.
 *
 * Nguyên tắc an toàn:
 *   · Cache là TỐI ƯU — mọi lỗi đọc/ghi DB của cache chỉ console.error và
 *     coi như cache-miss (fail-open về recompute), KHÔNG bao giờ làm hỏng
 *     caller (ngược chiều với guard() A9 — nơi DB lỗi phải lên SEVERE).
 *   · Payload phải JSON an toàn (TopAdtvSymbol thuần primitive — không Date).
 */

import { db } from "@/lib/db";

/** TTL L1 — sau khi đọc từ L2, mục giữ thời hạn còn lại của L2 (≤ TTL này). */
export const FEATURE_CACHE_TTL_MS = 90_000;

/** TTL L2 (bảng Postgres) — dài hơn nhiều chu kỳ agents; invalidation chủ
 *  động mới là cơ chế chính xác chính, TTL chỉ chống leak vĩnh viễn. */
export const FEATURE_CACHE_L2_TTL_MS = 600_000;

/** Tiền tố key của rổ thanh khoản (invalidation dùng chung tiền tố). */
export const TOPBYADTV_CACHE_PREFIX = "topByAdtv:";

/* ── L1 in-process ─────────────────────────────────────────────────── */

interface L1Entry {
  json: string;
  expiresAt: number;
}

const l1 = new Map<string, L1Entry>();

/** Thống kê L1 cho kiểm định / chẩn đoán (scripts/p2-verify.ts). */
export function featureCacheStats(): { l1Keys: string[]; l1Size: number } {
  const now = Date.now();
  for (const [k, v] of l1) {
    if (v.expiresAt <= now) l1.delete(k);
  }
  return { l1Keys: [...l1.keys()], l1Size: l1.size };
}

/** Xoá sạch L1 (dùng bởi kiểm định để mô phỏng process mới). */
export function clearFeatureCacheL1(): void {
  l1.clear();
}

/* ── API công khai ─────────────────────────────────────────────────── */

/**
 * Đọc giá trị cache theo key (JSON string). Trả null khi: hết hạn / chưa
 * có / lỗi DB (fail-open — caller recompute). Parse JSON do caller làm
 * (biết kiểu của mình); parse fail → caller tự recompute.
 */
export async function cacheGetJson(key: string): Promise<string | null> {
  const now = Date.now();
  const hit = l1.get(key);
  if (hit != null) {
    if (hit.expiresAt > now) return hit.json;
    l1.delete(key); // hết hạn — rơi xuống L2/recompute
  }
  try {
    const row = await db.featureValue.findUnique({ where: { key } });
    if (!row) return null;
    if (row.expiresAt.getTime() <= now) return null; // L2 hết hạn
    // Nạp lại L1 với TTL còn lại của L2 (không kéo dài tuổi thọ)
    l1.set(key, { json: row.value, expiresAt: row.expiresAt.getTime() });
    return row.value;
  } catch (err) {
    // Fail-open: cache không đọc được → caller recompute như chưa có cache
    console.error(`[feature-cache] đọc L2 "${key}" thất bại:`, err);
    return null;
  }
}

/**
 * Ghi cache: L1 (ttl ngắn) + L2 (ttl dài, mặc định 10 phút — best-effort,
 * lỗi ghi L2 chỉ log, không throw để không bao giờ làm chết đường tính chính).
 */
export async function cacheSetJson(
  key: string,
  json: string,
  ttlL1Ms: number = FEATURE_CACHE_TTL_MS,
  ttlL2Ms: number = FEATURE_CACHE_L2_TTL_MS
): Promise<void> {
  l1.set(key, { json, expiresAt: Date.now() + ttlL1Ms });
  try {
    await db.featureValue.upsert({
      where: { key },
      create: { key, value: json, expiresAt: new Date(Date.now() + ttlL2Ms) },
      update: { value: json, expiresAt: new Date(Date.now() + ttlL2Ms), computedAt: new Date() },
    });
  } catch (err) {
    console.error(`[feature-cache] ghi L2 "${key}" thất bại:`, err);
  }
}

/**
 * Xoá cache theo tiền tố key (L1 + L2). Gọi sau khi Bar đổi: eod-sync nạp
 * nến mới → ADTV đổi; corporate-events adjust/reverse ×f → value đổi;
 * tick simulated rollover / reprobe / intl-eod ghi bar mới. Best-effort —
 * lỗi DB chỉ log (TTL còn lại tự hồi phục đúng).
 */
export async function invalidateFeatureCache(prefix: string): Promise<void> {
  for (const k of [...l1.keys()]) {
    if (k.startsWith(prefix)) l1.delete(k);
  }
  try {
    await db.featureValue.deleteMany({ where: { key: { startsWith: prefix } } });
  } catch (err) {
    console.error(`[feature-cache] xoá L2 tiền tố "${prefix}" thất bại:`, err);
  }
}
