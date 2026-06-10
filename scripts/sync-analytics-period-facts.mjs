/**
 * Pull store-level ShopifyQL daily totals into shopify_analytics_period_facts.
 * Same logic as supabase/functions/_shared/shopify-analytics-facts-sync.ts
 *
 * Usage:
 *   SHOPIFY_STORE_DOMAIN=... SHOPIFY_ACCESS_TOKEN=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/sync-analytics-period-facts.mjs
 *   node scripts/sync-analytics-period-facts.mjs --days-back 30
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const envPath = resolve(root, ".env");

function loadDotEnv() {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    let v = m[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotEnv();

const args = process.argv.slice(2);
function argValue(name, def) {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1]) return def;
  return args[i + 1];
}

const SHOPIFYQL_API_VERSION = "2025-10";
const SHOPIFY_ANALYTICS_EPOCH_YMD = "2024-11-01";

const shopDomain = (process.env.SHOPIFY_STORE_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const accessToken = (process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
const supabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const printJsonOnly = args.includes("--print-json");
const outputFile = argValue("--output-file", "");

if (!printJsonOnly && (!supabaseUrl || !serviceKey)) {
  console.error("Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or pass --print-json)");
  process.exit(1);
}

const supabase = serviceKey && supabaseUrl ? createClient(supabaseUrl, serviceKey) : null;

async function resolveShopifyCredentials() {
  let domain = shopDomain;
  let token = accessToken;
  if (supabase && (!domain || !token)) {
    const { data, error } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["shopify_store_domain", "shopify_access_token"]);
    if (error) throw error;
    const map = Object.fromEntries((data || []).map((row) => [row.key, row.value]));
    domain = domain || String(map.shopify_store_domain || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
    token = token || String(map.shopify_access_token || "").trim();
  }
  return { domain, token };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function parseMoney(v) {
  if (v == null || String(v).trim() === "") return 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? round2(n) : 0;
}
function parseDiscount(v) {
  return round2(Math.abs(parseMoney(v)));
}

function formatDubaiDay(d) {
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

function addDaysIso(day, delta) {
  const [y, m, d] = day.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

function listDubaiDays(fromDay, throughDay) {
  const days = [];
  let cursor = fromDay;
  while (cursor <= throughDay) {
    days.push(cursor);
    cursor = addDaysIso(cursor, 1);
  }
  return days;
}

function resolvePeriodFactsSyncDays(throughDay) {
  const fromDay = throughDay < SHOPIFY_ANALYTICS_EPOCH_YMD ? throughDay : SHOPIFY_ANALYTICS_EPOCH_YMD;
  return listDubaiDays(fromDay, throughDay);
}

/** One Dubai reporting day — SINCE and UNTIL must be the same date (Shopify Admin single-day filter). */
const periodQuery = (day) =>
  `FROM sales SHOW gross_sales, discounts, returns, net_sales, taxes, total_sales, shipping_charges, orders SINCE ${day} UNTIL ${day}`;

async function runShopifyql(query, domain, token) {
  const res = await fetch(`https://${domain}/admin/api/${SHOPIFYQL_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({
      query: `query ($q: String!) {
        shopifyqlQuery(query: $q) {
          parseErrors
          tableData { rows }
        }
      }`,
      variables: { q: query },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`ShopifyQL HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

const { domain: resolvedDomain, token: resolvedToken } = await resolveShopifyCredentials();
if (!resolvedDomain || !resolvedToken) {
  console.error("Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN, or SUPABASE_SERVICE_ROLE_KEY to load from app_settings");
  process.exit(1);
}

const throughDay = formatDubaiDay(new Date());
const days = resolvePeriodFactsSyncDays(throughDay);

console.log(`Syncing ${days.length} Dubai days (${days[0]} .. ${throughDay}) via ${resolvedDomain}`);

const upserts = [];
for (const day of days) {
  const query = periodQuery(day);
  const json = await runShopifyql(query, resolvedDomain, resolvedToken);
  const payload = json.data?.shopifyqlQuery;
  const parseErrors = payload?.parseErrors ?? [];
  if (parseErrors.length) {
    console.error("Parse errors for", day, parseErrors);
    process.exit(1);
  }
  const row = payload?.tableData?.rows?.[0];
  if (!row) {
    console.warn("No row for", day);
    continue;
  }
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
  process.stdout.write(".");
}

if (printJsonOnly) {
  const json = JSON.stringify(upserts);
  if (outputFile) {
    writeFileSync(resolve(root, outputFile), json, "utf8");
    console.log(`Wrote ${upserts.length} rows to ${outputFile}`);
  } else {
    process.stdout.write(json);
  }
  process.exit(0);
}

console.log(`\nUpserting ${upserts.length} rows...`);
const { error } = await supabase.from("shopify_analytics_period_facts").upsert(upserts, { onConflict: "reporting_day" });
if (error) {
  console.error(error);
  process.exit(1);
}

const today = upserts.find((r) => r.reporting_day === throughDay);
console.log("Done.", today ? `Today: gross=${today.gross_sales} disc=${today.discounts} total=${today.total_sales}` : "");
