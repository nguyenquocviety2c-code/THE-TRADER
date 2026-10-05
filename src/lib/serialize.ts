/**
 * BigInt values are not JSON-serializable (Prisma SQLite uses BigInt for
 * VND money columns). Recursively convert any BigInt to Number before
 * passing payloads to NextResponse.json().
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toPlain<T>(value: T): any {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => toPlain(v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toPlain(v);
    }
    return out;
  }
  return value;
}
