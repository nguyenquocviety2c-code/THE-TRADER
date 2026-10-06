/**
 * BigInt values are not JSON-serializable (Prisma Postgres uses BigInt for
 * VND money columns). Recursively convert any BigInt to Number before
 * passing payloads to NextResponse.json().
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * F-114 (audit 19-b): thêm guard circular reference (WeakSet) + chuyển
 * Map/Set thành plain object/array — tránh RangeError "Maximum call stack"
 * khi serialize object tự tham chiếu hoặc payload chứa Map/Set.
 */
export function toPlain<T>(value: T, seen: WeakSet<object> = new WeakSet()): any {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  // Guard circular ở ĐẦU hàm — áp cho mọi object (kể cả mảng/Map/Set)
  if (typeof value === "object" && value !== null) {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
  }
  if (value instanceof Map) return toPlain(Object.fromEntries(value), seen);
  if (value instanceof Set) return toPlain(Array.from(value), seen);
  if (Array.isArray(value)) return value.map((v) => toPlain(v, seen));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toPlain(v, seen);
    }
    return out;
  }
  return value;
}
