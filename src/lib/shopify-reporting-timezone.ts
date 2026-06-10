import { TZDate } from "@date-fns/tz";
import { startOfDay, addDays } from "date-fns";

/** Shopify store reporting timezone (Abu Dhabi / Muscat, GMT+04:00). */
export const SHOPIFY_REPORTING_TIMEZONE = "Asia/Dubai";

export function storeNow(now: Date = new Date()): TZDate {
  return new TZDate(now, SHOPIFY_REPORTING_TIMEZONE);
}

export function storeStartOfDay(d: TZDate): TZDate {
  return startOfDay(d) as TZDate;
}

/** Exclusive period end: midnight at the start of the next store-local day. */
export function storeExclusiveEndAfter(d: TZDate): TZDate {
  return storeStartOfDay(addDays(d, 1) as TZDate);
}

export function storeDayFromYmd(ymd: string): TZDate | null {
  const parts = ymd.split("-").map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const [y, m, d] = parts;
  return new TZDate(y, m - 1, d, SHOPIFY_REPORTING_TIMEZONE);
}

export function toStoreUtcIso(d: TZDate | Date | null): string | null {
  if (!d) return null;
  return new Date(d.getTime()).toISOString();
}

export function toStoreYmd(d: TZDate | Date | null): string {
  if (!d) return "";
  const tz = d instanceof TZDate ? d : new TZDate(d, SHOPIFY_REPORTING_TIMEZONE);
  const y = tz.getFullYear();
  const m = String(tz.getMonth() + 1).padStart(2, "0");
  const day = String(tz.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function storeDayStartIsoFromYmd(ymd?: string | null): string | null {
  const tzDate = ymd ? storeDayFromYmd(ymd) : null;
  if (!tzDate) return null;
  return toStoreUtcIso(storeStartOfDay(tzDate));
}

/** Exclusive upper bound for a YMD date (start of the following store-local day, UTC). */
export function storeDayEndExclusiveIsoFromYmd(ymd?: string | null): string | null {
  const tzDate = ymd ? storeDayFromYmd(ymd) : null;
  if (!tzDate) return null;
  return toStoreUtcIso(storeExclusiveEndAfter(storeStartOfDay(tzDate)));
}

export function storeTimeseriesBucket(
  iso: string,
  bucket: "day" | "month",
): { key: string; label: string } {
  const tz = new TZDate(iso, SHOPIFY_REPORTING_TIMEZONE);
  if (bucket === "day") {
    const key = toStoreYmd(tz);
    const label = new TZDate(`${key}T12:00:00`, SHOPIFY_REPORTING_TIMEZONE).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: SHOPIFY_REPORTING_TIMEZONE,
    });
    return { key, label };
  }
  const key = `${tz.getFullYear()}-${String(tz.getMonth() + 1).padStart(2, "0")}`;
  const label = new TZDate(tz.getFullYear(), tz.getMonth(), 1, SHOPIFY_REPORTING_TIMEZONE).toLocaleDateString(
    "en-GB",
    {
      month: "short",
      year: "numeric",
      timeZone: SHOPIFY_REPORTING_TIMEZONE,
    },
  );
  return { key, label };
}
