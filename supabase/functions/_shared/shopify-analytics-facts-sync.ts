import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { normalizeShopifyDomain } from "./shopify-credentials.ts";

/** ShopifyQL is on newer Admin API versions; requires `read_reports` scope. */
const SHOPIFYQL_API_VERSION = "2025-10";

/** Earliest Dubai reporting day for Shopify Analytics parity (All time floor). */
export const SHOPIFY_ANALYTICS_EPOCH_YMD = "2024-11-01";

export type ShopifyAnalyticsFactsSyncResult = {
  synced: number;
  skipped: boolean;
  error?: string;
  parseErrors?: string[];
  query?: string;
};

type ShopifyqlResponse = {
  data?: {
    shopifyqlQuery?: {
      parseErrors?: string[];
      tableData?: {
        columns?: { name: string }[];
        rows?: Record<string, string>[];
      };
    };
  };
  errors?: { message?: string }[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseMoney(value: string | null | undefined): number {
  if (value == null || String(value).trim() === "") return 0;
  const n = parseFloat(String(value));
  return Number.isFinite(n) ? round2(n) : 0;
}

/** Positive discount amount for CRM subtraction (ShopifyQL returns negative). */
function parseDiscount(value: string | null | undefined): number {
  return round2(Math.abs(parseMoney(value)));
}

function formatDubaiDay(d: Date): string {
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

function addDaysIso(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

function listDubaiDays(fromDay: string, throughDay: string): string[] {
  const days: string[] = [];
  let cursor = fromDay;
  while (cursor <= throughDay) {
    days.push(cursor);
    cursor = addDaysIso(cursor, 1);
  }
  return days;
}

async function runShopifyql(
  shopDomain: string,
  accessToken: string,
  query: string,
): Promise<ShopifyqlResponse> {
  const host = normalizeShopifyDomain(shopDomain);
  const res = await fetch(`https://${host}/admin/api/${SHOPIFYQL_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: `query ($q: String!) {
        shopifyqlQuery(query: $q) {
          parseErrors
          tableData { columns { name } rows }
        }
      }`,
      variables: { q: query },
    }),
  });
  const text = await res.text();
  let json: ShopifyqlResponse = {};
  try {
    json = JSON.parse(text) as ShopifyqlResponse;
  } catch {
    throw new Error(`ShopifyQL HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.ok) {
    throw new Error(`ShopifyQL HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

function shopifyqlUnavailable(json: ShopifyqlResponse): string | null {
  const msg = json.errors?.map((e) => e.message).join("; ") || "";
  if (/shopifyqlQuery.*doesn't exist/i.test(msg)) {
    return "ShopifyQL is not available on this API token (add read_reports scope and re-install the custom app).";
  }
  if (/read_reports/i.test(msg) || /Access denied for shopifyqlQuery/i.test(msg)) {
    return "Missing read_reports scope on the Shopify custom app token.";
  }
  return msg || null;
}

/** One Dubai reporting day — SINCE and UNTIL must be the same date (Shopify Admin single-day filter). */
export function shopifyqlPeriodFactsQueryForDay(day: string): string {
  return `FROM sales SHOW gross_sales, discounts, returns, net_sales, taxes, total_sales, shipping_charges, orders SINCE ${day} UNTIL ${day}`;
}

/** Dubai reporting days to refresh after order webhooks (last 7 = Last 7 days filter). */
export function dubaiRecentPeriodFactDays(): string[] {
  const today = formatDubaiDay(new Date());
  const fromDay = addDaysIso(today, -6);
  return listDubaiDays(fromDay, today);
}

/** Dubai reporting day strings for today and yesterday (sales event attribution window). */
export function dubaiTodayAndYesterday(): string[] {
  const today = formatDubaiDay(new Date());
  const yesterday = addDaysIso(today, -1);
  return [yesterday, today];
}

function resolvePeriodFactsSyncDays(throughDay: string): string[] {
  const fromDay = throughDay < SHOPIFY_ANALYTICS_EPOCH_YMD ? throughDay : SHOPIFY_ANALYTICS_EPOCH_YMD;
  return listDubaiDays(fromDay, throughDay);
}

async function fetchPeriodFactsForDays(
  shopDomain: string,
  accessToken: string,
  days: string[],
): Promise<{ upserts: Record<string, unknown>[]; lastQuery: string; error?: ShopifyAnalyticsFactsSyncResult }> {
  const upserts: Record<string, unknown>[] = [];
  let usedQuery = "";

  for (const day of [...new Set(days)].sort()) {
    const query = shopifyqlPeriodFactsQueryForDay(day);
    usedQuery = query;

    const json = await runShopifyql(shopDomain, accessToken, query);
    const unavailable = shopifyqlUnavailable(json);
    if (unavailable) {
      return { upserts, lastQuery: query, error: { synced: 0, skipped: true, error: unavailable, query } };
    }

    const payload = json.data?.shopifyqlQuery;
    const parseErrors = payload?.parseErrors ?? [];
    if (parseErrors.length > 0) {
      return {
        upserts,
        lastQuery: query,
        error: {
          synced: upserts.length,
          skipped: true,
          error: parseErrors.join("; "),
          parseErrors,
          query,
        },
      };
    }

    const row = payload?.tableData?.rows?.[0];
    if (!row) continue;

    upserts.push({
      reporting_day: day,
      gross_sales: parseMoney(row.gross_sales),
      discounts: parseDiscount(row.discounts),
      returns_refunded: round2(Math.abs(parseMoney(row.returns))),
      net_sales: parseMoney(row.net_sales),
      shipping_charges: parseMoney(row.shipping_charges),
      return_fees: 0,
      taxes: parseMoney(row.taxes),
      total_sales: parseMoney(row.total_sales),
      orders_count: Math.max(0, Math.floor(parseMoney(row.orders))),
      synced_at: new Date().toISOString(),
    });
  }

  return { upserts, lastQuery: usedQuery };
}

/** Refresh specific Dubai reporting days (webhook path — typically today + yesterday). */
export async function syncShopifyAnalyticsPeriodFactsForDays(
  supabase: SupabaseClient,
  shopDomain: string,
  accessToken: string,
  days: string[],
): Promise<ShopifyAnalyticsFactsSyncResult> {
  if (!days.length) return { synced: 0, skipped: false };

  const { upserts, lastQuery, error } = await fetchPeriodFactsForDays(shopDomain, accessToken, days);
  if (error) return error;

  if (upserts.length === 0) {
    return { synced: 0, skipped: false, query: lastQuery };
  }

  const { error: upsertErr } = await supabase
    .from("shopify_analytics_period_facts")
    .upsert(upserts, { onConflict: "reporting_day" });
  if (upsertErr) throw upsertErr;

  return { synced: upserts.length, skipped: false, query: lastQuery };
}

/**
 * Pull store-level Shopify Analytics totals per Dubai reporting day (sales event attribution).
 * Matches Shopify Admin Analytics breakdown — not order-created-at subtotals.
 */
export async function syncShopifyAnalyticsOrderFacts(
  supabase: SupabaseClient,
  shopDomain: string,
  accessToken: string,
  options: { throughDay?: string } = {},
): Promise<ShopifyAnalyticsFactsSyncResult> {
  const throughDay = options.throughDay ?? formatDubaiDay(new Date());
  const days = resolvePeriodFactsSyncDays(throughDay);

  const { upserts, lastQuery, error } = await fetchPeriodFactsForDays(shopDomain, accessToken, days);
  if (error) return error;

  if (upserts.length === 0) {
    return { synced: 0, skipped: false, query: lastQuery };
  }

  const { error: upsertErr } = await supabase
    .from("shopify_analytics_period_facts")
    .upsert(upserts, { onConflict: "reporting_day" });
  if (upsertErr) throw upsertErr;

  return { synced: upserts.length, skipped: false, query: lastQuery };
}
