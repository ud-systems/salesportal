/** Shared day-list helpers for ShopifyQL period-facts sync (Asia/Dubai YMD). */

import { SHOPIFY_ANALYTICS_EPOCH_YMD } from "@/lib/shopify-analytics-epoch";

export function addDaysIso(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

export function listDubaiDays(fromDay: string, throughDay: string): string[] {
  const days: string[] = [];
  let cursor = fromDay;
  while (cursor <= throughDay) {
    days.push(cursor);
    cursor = addDaysIso(cursor, 1);
  }
  return days;
}

/** Every Dubai reporting day from analytics epoch through `throughDay` (inclusive). */
export function resolvePeriodFactsSyncDays(throughDay: string): string[] {
  const fromDay = throughDay < SHOPIFY_ANALYTICS_EPOCH_YMD ? throughDay : SHOPIFY_ANALYTICS_EPOCH_YMD;
  return listDubaiDays(fromDay, throughDay);
}

export function dubaiLastNDays(n: number, throughDay?: string): string[] {
  const end = throughDay ?? formatDubaiDayUtc(new Date());
  const count = Math.max(1, n);
  const fromDay = addDaysIso(end, -(count - 1));
  return listDubaiDays(fromDay, end);
}

export function formatDubaiDayUtc(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}
