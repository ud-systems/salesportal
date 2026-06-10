import fs from "node:fs";
import path from "node:path";

const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
const files = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const functionStarts = [];
for (const file of files) {
  const content = fs.readFileSync(path.join(migrationsDir, file), "utf8");
  const regex = /CREATE OR REPLACE FUNCTION public\.(\w+)\(/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    functionStarts.push({ name: match[1], file, index: match.index });
  }
}

const latestByName = new Map();
for (const entry of functionStarts) {
  latestByName.set(entry.name, entry);
}

const TARGET_FUNCTIONS = [
  "shopify_analytics_returns_for_scope",
  "shopify_analytics_return_fees_for_scope",
  "get_scope_shopify_sales_breakdown",
  "get_selected_salespeople_shopify_sales_breakdown",
  "get_scope_shopify_analytics_dashboard",
  "get_selected_salespeople_shopify_analytics_dashboard",
  "get_scope_shopify_sales_breakdown_for_viewers",
  "get_scope_financial_breakdown",
  "get_scope_financial_breakdown_for_viewers",
  "get_salesperson_financial_breakdown_rows",
  "get_selected_salespeople_scope_metrics_timeseries",
  "get_scope_order_timeseries",
  "get_supervisor_selected_manager_timeseries",
  "get_manager_selected_salespeople_timeseries",
  "get_scope_order_metrics",
  "get_scope_order_metrics_for_viewers",
  "get_scoped_customers_page",
  "get_scoped_orders_page",
  "get_scoped_order_items_page",
  "get_analytics_overview_kpis",
  "get_analytics_rfm_group_breakdown",
  "get_analytics_scope_performance_rows",
  "get_analytics_top_products",
  "get_analytics_top_customers",
  "get_analytics_payment_status_breakdown",
  "get_analytics_fulfillment_status_breakdown",
  "get_analytics_tax_summary_rows",
  "get_analytics_sales_by_salesperson",
  "get_supervisor_manager_self_performance_row",
  "get_supervisor_manager_scope_scorecards",
  "get_salesperson_performance_rows",
  "get_admin_order_financial_reconciliation",
];

function extractFunction(content, startIndex) {
  const grantIdx = content.indexOf("\nGRANT EXECUTE", startIndex);
  const nextFnIdx = content.indexOf("\nCREATE OR REPLACE FUNCTION", startIndex + 1);
  const endMarkers = [grantIdx, nextFnIdx].filter((i) => i >= 0);
  const endIdx = endMarkers.length ? Math.min(...endMarkers) : content.length;
  return content.slice(startIndex, endIdx).trim();
}

function patchFunctionBody(sql) {
  let out = sql;
  out = out.replace(/<= _to_iso/g, "< _to_iso");
  out = out.replace(/<= \$8/g, "< $8");
  out = out.replace(/o\.shopify_created_at <= _to_iso/g, "o.shopify_created_at < _to_iso");

  const dayBucket = "public.shopify_reporting_day_bucket(o.shopify_created_at)";
  const monthBucket = "public.shopify_reporting_month_bucket(o.shopify_created_at)";
  const dayBucketOrderCreated = "public.shopify_reporting_day_bucket(order_created_at)";
  const monthBucketOrderCreated = "public.shopify_reporting_month_bucket(order_created_at)";

  out = out.replace(
    /date_trunc\('day', o\.shopify_created_at\)/g,
    dayBucket,
  );
  out = out.replace(
    /date_trunc\('month', o\.shopify_created_at\)/g,
    monthBucket,
  );
  out = out.replace(
    /date_trunc\('day', order_created_at\)/g,
    dayBucketOrderCreated,
  );
  out = out.replace(
    /date_trunc\('month', order_created_at\)/g,
    monthBucketOrderCreated,
  );

  return out;
}

const header = `-- Anchor Shopify reporting to Asia/Dubai (GMT+04:00) and use exclusive period end boundaries.
-- _from_iso: inclusive start (UTC)
-- _to_iso: exclusive end (UTC) — records satisfy: ts >= _from_iso AND ts < _to_iso

CREATE OR REPLACE FUNCTION public.shopify_reporting_timezone()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'Asia/Dubai'::text;
$$;

CREATE OR REPLACE FUNCTION public.shopify_reporting_ts_in_period(
  _ts timestamptz,
  _from_iso timestamptz,
  _to_iso timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (_from_iso IS NULL OR _ts >= _from_iso)
     AND (_to_iso IS NULL OR _ts < _to_iso);
$$;

CREATE OR REPLACE FUNCTION public.shopify_reporting_day_bucket(_ts timestamptz)
RETURNS timestamp without time zone
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT date_trunc('day', _ts AT TIME ZONE public.shopify_reporting_timezone());
$$;

CREATE OR REPLACE FUNCTION public.shopify_reporting_month_bucket(_ts timestamptz)
RETURNS timestamp without time zone
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT date_trunc('month', _ts AT TIME ZONE public.shopify_reporting_timezone());
$$;

GRANT EXECUTE ON FUNCTION public.shopify_reporting_timezone() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_reporting_ts_in_period(timestamptz, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_reporting_day_bucket(timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_reporting_month_bucket(timestamptz) TO authenticated, service_role;

`;

const chunks = [header];
const missing = [];

for (const name of TARGET_FUNCTIONS) {
  const entry = latestByName.get(name);
  if (!entry) {
    missing.push(name);
    continue;
  }
  const content = fs.readFileSync(path.join(migrationsDir, entry.file), "utf8");
  const fnSql = patchFunctionBody(extractFunction(content, entry.index));
  chunks.push(`-- Patched from ${entry.file}\n${fnSql}\n\n`);
}

if (missing.length) {
  chunks.push(`-- Functions not found in migrations: ${missing.join(", ")}\n`);
}

const outPath = path.join(migrationsDir, "20260609100000_shopify_reporting_timezone_exclusive_periods.sql");
fs.writeFileSync(outPath, chunks.join("\n"));
console.log(`Wrote ${outPath}`);
if (missing.length) console.warn("Missing:", missing.join(", "));
