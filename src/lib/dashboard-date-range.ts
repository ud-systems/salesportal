import {
  addDays,
  subDays,
  subMonths,
  subQuarters,
  subYears,
  subWeeks,
  startOfQuarter,
  startOfMonth,
  startOfYear,
  startOfWeek,
  differenceInCalendarDays,
} from "date-fns";
import { TZDate } from "@date-fns/tz";
import {
  SHOPIFY_REPORTING_TIMEZONE,
  storeNow,
  storeStartOfDay,
  storeExclusiveEndAfter,
  storeDayFromYmd,
  toStoreUtcIso,
  toStoreYmd,
} from "@/lib/shopify-reporting-timezone";
import { SHOPIFY_ANALYTICS_EPOCH_YMD } from "@/lib/shopify-analytics-epoch";

export { SHOPIFY_ANALYTICS_EPOCH_YMD };

export type DatePreset =
  | "all"
  | "today"
  | "yesterday"
  | "wtd"
  | "week"
  | "month"
  | "quarter"
  | "year"
  | "custom";

export type DateRangeResult = {
  /** Inclusive start (store-local midnight as UTC). */
  from: TZDate | null;
  /** Exclusive end (store-local midnight of the next day/period as UTC). */
  to: TZDate | null;
  compareFrom: TZDate | null;
  compareTo: TZDate | null;
};

/** UK retail week: Monday start through end of today (store timezone). */
const WEEK_STARTS_ON = 1 as const;

export { SHOPIFY_REPORTING_TIMEZONE };

export function formatPresetLabel(preset: DatePreset): string {
  switch (preset) {
    case "all":
      return "All time";
    case "today":
      return "Today";
    case "yesterday":
      return "Yesterday";
    case "wtd":
      return "Week to date";
    case "week":
      return "Last 7 days";
    case "month":
      return "This month";
    case "quarter":
      return "This quarter";
    case "year":
      return "This year";
    case "custom":
      return "Custom range";
    default:
      return "Period";
  }
}

export function trendTitleForPreset(preset: DatePreset, topic: "revenue" | "generic" = "generic"): string {
  if (preset === "all" && topic === "revenue") return "All Time Revenue Trend";
  const label = formatPresetLabel(preset);
  if (topic === "revenue") return `${label} Revenue Trend`;
  return `${label} Trend`;
}

function compareExclusiveEnd(periodStart: TZDate, periodEndInclusive: TZDate): TZDate {
  return storeExclusiveEndAfter(periodEndInclusive);
}

export function getDashboardRange(
  preset: DatePreset,
  customFromYmd?: string,
  customToYmd?: string,
  now: Date = new Date(),
): DateRangeResult {
  if (preset === "all") {
    const storeToday = storeNow(now);
    const from = storeStartOfDay(storeDayFromYmd(SHOPIFY_ANALYTICS_EPOCH_YMD)!);
    const to = storeExclusiveEndAfter(storeStartOfDay(storeToday));
    return { from, to, compareFrom: null, compareTo: null };
  }

  const storeToday = storeNow(now);

  if (preset === "custom" && customFromYmd && customToYmd) {
    const from = storeStartOfDay(storeDayFromYmd(customFromYmd)!);
    const lastDay = storeStartOfDay(storeDayFromYmd(customToYmd)!);
    const to = storeExclusiveEndAfter(lastDay);
    const days = Math.max(1, differenceInCalendarDays(lastDay, from) + 1);
    const compareTo = from;
    const compareFrom = storeStartOfDay(subDays(from, days) as TZDate);
    return { from, to, compareFrom, compareTo };
  }

  const to = storeExclusiveEndAfter(storeStartOfDay(storeToday));

  if (preset === "today") {
    const from = storeStartOfDay(storeToday);
    const y = subDays(storeToday, 1) as TZDate;
    return { from, to, compareFrom: storeStartOfDay(y), compareTo: from };
  }

  if (preset === "yesterday") {
    const y = subDays(storeToday, 1) as TZDate;
    const from = storeStartOfDay(y);
    const py = subDays(y, 1) as TZDate;
    return { from, to: storeStartOfDay(storeToday), compareFrom: storeStartOfDay(py), compareTo: from };
  }

  if (preset === "wtd") {
    const from = startOfWeek(storeToday, { weekStartsOn: WEEK_STARTS_ON }) as TZDate;
    const compareStart = startOfWeek(subWeeks(storeToday, 1), { weekStartsOn: WEEK_STARTS_ON }) as TZDate;
    const offset = differenceInCalendarDays(storeToday, from);
    const compareEndInclusive = addDays(compareStart, offset) as TZDate;
    return {
      from,
      to,
      compareFrom: compareStart,
      compareTo: compareExclusiveEnd(compareStart, compareEndInclusive),
    };
  }

  if (preset === "week") {
    const from = storeStartOfDay(subDays(storeToday, 6) as TZDate);
    const compareEndInclusive = subDays(from, 1) as TZDate;
    const compareFrom = storeStartOfDay(subDays(compareEndInclusive, 6) as TZDate);
    return {
      from,
      to,
      compareFrom,
      compareTo: compareExclusiveEnd(compareFrom, compareEndInclusive),
    };
  }

  if (preset === "month") {
    const from = startOfMonth(storeToday) as TZDate;
    const compareStart = startOfMonth(subMonths(storeToday, 1)) as TZDate;
    const offset = differenceInCalendarDays(storeToday, from);
    const compareEndInclusive = addDays(compareStart, offset) as TZDate;
    return {
      from,
      to,
      compareFrom: compareStart,
      compareTo: compareExclusiveEnd(compareStart, compareEndInclusive),
    };
  }

  if (preset === "quarter") {
    const from = startOfQuarter(storeToday) as TZDate;
    const compareStart = startOfQuarter(subQuarters(storeToday, 1)) as TZDate;
    const offset = differenceInCalendarDays(storeToday, from);
    const compareEndInclusive = addDays(compareStart, offset) as TZDate;
    return {
      from,
      to,
      compareFrom: compareStart,
      compareTo: compareExclusiveEnd(compareStart, compareEndInclusive),
    };
  }

  if (preset === "year") {
    const from = startOfYear(storeToday) as TZDate;
    const compareStart = startOfYear(subYears(storeToday, 1)) as TZDate;
    const offset = differenceInCalendarDays(storeToday, from);
    const compareEndInclusive = addDays(compareStart, offset) as TZDate;
    return {
      from,
      to,
      compareFrom: compareStart,
      compareTo: compareExclusiveEnd(compareStart, compareEndInclusive),
    };
  }

  const from = storeStartOfDay(subDays(storeToday, 29) as TZDate);
  const compareEndInclusive = subDays(from, 1) as TZDate;
  const compareFrom = storeStartOfDay(subDays(compareEndInclusive, 29) as TZDate);
  return {
    from,
    to,
    compareFrom,
    compareTo: compareExclusiveEnd(compareFrom, compareEndInclusive),
  };
}

/** UTC ISO for inclusive `_from_iso` RPC parameter. */
export function toRangeIso(d: TZDate | Date | null): string | null {
  return toStoreUtcIso(d);
}

/** UTC ISO for exclusive `_to_iso` RPC parameter (already exclusive in range.to). */
export function toRangeToIso(d: TZDate | Date | null): string | null {
  return toStoreUtcIso(d);
}

export function toLocalYmd(d: TZDate | Date | null): string {
  return toStoreYmd(d);
}
