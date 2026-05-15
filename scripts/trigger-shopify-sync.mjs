/**
 * Trigger shopify-sync edge function from your machine (same as the app, but scriptable).
 *
 * Auth (pick one):
 *   1) SHOPIFY_CRON_SECRET — must match Edge secret SHOPIFY_CRON_SECRET (header x-shopify-cron-secret).
 *   2) SYNC_ADMIN_JWT — a valid Supabase user access_token for an admin/owner (from browser DevTools → Application → Local Storage → supabase.auth.token).
 *
 * Usage:
 *   node scripts/trigger-shopify-sync.mjs
 *   node scripts/trigger-shopify-sync.mjs --module orders --reset-orders-checkpoint
 *
 * Defaults VITE_SUPABASE_URL from ../.env if present.
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const envPath = resolve(root, ".env");

function loadDotEnv() {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    let v = m[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

loadDotEnv();

const args = process.argv.slice(2);
function argFlag(name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  return true;
}
function argValue(name, def) {
  const i = args.indexOf(name);
  if (i === -1 || !args[i + 1]) return def;
  return args[i + 1];
}

const moduleArg = argValue("--module", "");
const resetOrders = argFlag("--reset-orders-checkpoint");
const resetCustomers = argFlag("--reset-customer-checkpoint");

const baseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const cronSecret = (process.env.SHOPIFY_CRON_SECRET || "").trim();
const jwt = (process.env.SYNC_ADMIN_JWT || "").trim();

if (!baseUrl) {
  console.error("Set VITE_SUPABASE_URL or SUPABASE_URL");
  process.exit(1);
}
if (!cronSecret && !jwt) {
  console.error("Set SHOPIFY_CRON_SECRET or SYNC_ADMIN_JWT in the environment.");
  process.exit(1);
}

const url = `${baseUrl}/functions/v1/shopify-sync`;
const body = {
  ...(moduleArg ? { module: moduleArg } : {}),
  ...(resetOrders ? { reset_orders_checkpoint: true } : {}),
  ...(resetCustomers ? { reset_customer_checkpoint: true } : {}),
};

const headers = {
  "Content-Type": "application/json",
  ...(cronSecret
    ? { "x-shopify-cron-secret": cronSecret }
    : { Authorization: `Bearer ${jwt}` }),
};

console.log("POST", url, JSON.stringify(body));
const res = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});

const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  json = text;
}
console.log(res.status, json);
if (!res.ok) process.exit(1);
