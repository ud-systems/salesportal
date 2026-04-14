import {
  addDays,
  endOfDay,
  startOfDay,
  subDays,
  subMonths,
  subQuarters,
  subYears,
  startOfQuarter,
  endOfQuarter,
  startOfMonth,
  startOfYear,
  differenceInCalendarDays,
} from "date-fns";

export type DatePreset = "all" | "today" | "week" | "month" | "quarter" | "year" | "custom";

export type DateRangeResult = {
  from: Date | null;
  to: Date | null;
  compareFrom: Date | null;
  compareTo: Date | null;
};

export function getDashboardRange(
  preset: DatePreset,
  customFromYmd?: string,
  customToYmd?: string,
  now: Date = new Date(),
): DateRangeResult {
  if (preset === "all") {
    return { from: null, to: null, compareFrom: null, compareTo: null };
  }

  if (preset === "custom" && customFromYmd && customToYmd) {
    const from = startOfDay(new Date(`${customFromYmd}T12:00:00`));
    const to = endOfDay(new Date(`${customToYmd}T12:00:00`));
    const days = Math.max(1, differenceInCalendarDays(to, from) + 1);
    const compareTo = endOfDay(subDays(from, 1));
    const compareFrom = startOfDay(subDays(compareTo, days - 1));
    return { from, to, compareFrom, compareTo };
  }

  const to = endOfDay(now);

  if (preset === "today") {
    const from = startOfDay(now);
    const y = subDays(now, 1);
    return { from, to, compareFrom: startOfDay(y), compareTo: endOfDay(y) };
  }

  if (preset === "week") {
    const from = startOfDay(subDays(now, 6));
    const compareTo = endOfDay(subDays(from, 1));
    const compareFrom = startOfDay(subDays(compareTo, 6));
    return { from, to, compareFrom, compareTo };
  }

  if (preset === "month") {
    const from = startOfMonth(now);
    const compareStart = startOfMonth(subMonths(now, 1));
    const offset = differenceInCalendarDays(now, from);
    const compareTo = endOfDay(addDays(compareStart, offset));
    return { from, to, compareFrom: compareStart, compareTo };
  }

  if (preset === "quarter") {
    const from = startOfQuarter(now);
    const compareStart = startOfQuarter(subQuarters(now, 1));
    const offset = differenceInCalendarDays(now, from);
    const compareTo = endOfDay(addDays(compareStart, offset));
    return { from, to, compareFrom: compareStart, compareTo };
  }

  if (preset === "year") {
    const from = startOfYear(now);
    const compareStart = startOfYear(subYears(now, 1));
    const offset = differenceInCalendarDays(now, from);
    const compareTo = endOfDay(addDays(compareStart, offset));
    return { from, to, compareFrom: compareStart, compareTo };
  }

  const from = startOfDay(subDays(now, 29));
  const compareTo = endOfDay(subDays(from, 1));
  const compareFrom = startOfDay(subDays(compareTo, 29));
  return { from, to, compareFrom, compareTo };
}

export function toRangeIso(d: Date | null): string | null {
  if (!d) return null;
  return d.toISOString();
}
