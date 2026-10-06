/**
 * Vietnamese formatting helpers (client-safe).
 * - VND money: "1.284.300.000 ₫" (vi-VN, no decimals)
 * - Percents with sign: "+1,25%" / "-0,88%"
 * - Compact volume: "1,8tr" / "2,4 tỷ"
 */

import { isTradingSession } from "@/lib/market-session";

const nf = new Intl.NumberFormat("vi-VN", {
  maximumFractionDigits: 0,
});

const nf1 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const nf2 = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "1.284.300.000 ₫" */
export function formatVnd(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${nf.format(Math.round(n))} ₫`;
}

/** "91.500" — plain VND price with grouping, no currency symbol */
export function formatPrice(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return nf.format(Math.round(n));
}

/** "+1.250" / "-3.300" */
export function formatSigned(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const s = nf.format(Math.abs(Math.round(n)));
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}

/** "+1,25%" / "-0,88%" / "0,00%" */
export function formatPct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const s = `${nf2.format(Math.abs(n))}%`;
  return n > 0 ? `+${s}` : n < 0 ? `-${s}` : s;
}

/** Compact share volume: 950 -> "950", 1_800_000 -> "1,8tr", 2_400_000_000 -> "2,4 tỷ" */
export function formatVolume(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${nf1.format(n / 1_000_000_000)} tỷ`;
  if (abs >= 1_000_000) return `${nf1.format(n / 1_000_000)}tr`;
  if (abs >= 10_000) return `${nf.format(Math.round(n / 1000))}K`;
  return nf.format(n);
}

/** Compact VND value: 12_540_000_000_000 -> "12.540 tỷ ₫" */
export function formatVndCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000_000) return `${nf.format(Math.round(n / 1_000_000_000))} tỷ ₫`;
  if (abs >= 1_000_000_000) return `${nf1.format(n / 1_000_000_000)} tỷ ₫`;
  if (abs >= 1_000_000) return `${nf1.format(n / 1_000_000)} tr ₫`;
  return formatVnd(n);
}

/** CSS class for change coloring */
export function changeColor(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n) || n === 0) return "text-muted-foreground";
  return n > 0 ? "text-up" : "text-down";
}

export function bgColor(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n) || n === 0) return "bg-muted";
  return n > 0 ? "bg-up" : "bg-down";
}

/** "14:32:05 · 05/10" style clock in Asia/Ho_Chi_Minh */
export function vnClock(d: Date): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

export function vnDate(d: Date): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/** "05/10 14:30" for tables */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/**
 * VN market session (Asia/Ho_Chi_Minh, Mon–Fri):
 * morning 09:15–11:30, afternoon 13:00–14:45.
 * F-112 (audit 19-b): ủy quyền cho market-session.ts (pure, client-safe) —
 * tôn trọng lịch nghỉ lễ VN thay vì tự tính session thủ công.
 */
export function isMarketOpen(now: Date = new Date()): boolean {
  return isTradingSession(now);
}
