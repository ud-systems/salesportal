/** UK-oriented display defaults (align with store / en-GB). */
export const DISPLAY_LOCALE = "en-GB";
export const DISPLAY_TIMEZONE = "Europe/London";
export const FALLBACK_STORE_CURRENCY = "GBP";

export function formatDisplayDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(DISPLAY_LOCALE, {
    timeZone: DISPLAY_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatDisplayDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(DISPLAY_LOCALE, {
    timeZone: DISPLAY_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatMoneyAmount(
  amount: number | null | undefined,
  currencyCode: string = FALLBACK_STORE_CURRENCY,
): string {
  const code = (currencyCode || FALLBACK_STORE_CURRENCY).toUpperCase();
  try {
    return new Intl.NumberFormat(DISPLAY_LOCALE, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(amount ?? 0));
  } catch {
    return `${code} ${Number(amount ?? 0).toLocaleString(DISPLAY_LOCALE)}`;
  }
}

export function formatOrderMoney(
  amount: number | null | undefined,
  rowCurrency: string | null | undefined,
  storeDefaultCurrency: string,
): string {
  return formatMoneyAmount(amount, rowCurrency || storeDefaultCurrency);
}

/** Compact chart axis (e.g. £12k) */
export function formatCompactMoney(value: number, currencyCode: string): string {
  const code = (currencyCode || FALLBACK_STORE_CURRENCY).toUpperCase();
  try {
    return new Intl.NumberFormat(DISPLAY_LOCALE, {
      style: "currency",
      currency: code,
      currencyDisplay: "symbol",
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: 1,
    }).format(Number(value || 0));
  } catch {
    return formatMoneyAmount(value, code);
  }
}
