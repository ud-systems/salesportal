/**
 * Run customer sync in a loop until the Shopify checkpoint is fully complete.
 * Each edge invocation stops before the runtime hard limit; this script resumes automatically.
 *
 * Usage:
 *   node scripts/resync-all-customers.mjs
 *   node scripts/resync-all-customers.mjs --reset
 *
 * Auth: SHOPIFY_CRON_SECRET or SYNC_ADMIN_JWT (same as trigger-shopify-sync.mjs).
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
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

loadDotEnv();

const reset = process.argv.includes("--reset");
const baseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "").replace(/\/$/, "");
const cronSecret = (process.env.SHOPIFY_CRON_SECRET || "").trim();
const jwt = (process.env.SYNC_ADMIN_JWT || "").trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

if (!baseUrl) {
  console.error("Set VITE_SUPABASE_URL or SUPABASE_URL");
  process.exit(1);
}
if (!cronSecret && !jwt) {
  console.error("Set SHOPIFY_CRON_SECRET or SYNC_ADMIN_JWT");
  process.exit(1);
}

const url = `${baseUrl}/functions/v1/shopify-sync`;
const headers = {
  "Content-Type": "application/json",
  ...(cronSecret ? { "x-shopify-cron-secret": cronSecret } : { Authorization: `Bearer ${jwt}` }),
};

async function getCheckpoint() {
  if (!serviceKey) return null;
  const res = await fetch(`${baseUrl}/rest/v1/sync_checkpoints?sync_type=eq.customers&select=cursor,last_completed_at`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows?.[0] ?? null;
}

async function runBatch(includeReset) {
  const body = {
    module: "customers",
    ...(includeReset ? { reset_customer_checkpoint: true } : {}),
  };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(400_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return json;
}

function isComplete(result, checkpoint) {
  const note = result?.results?.customers?.note || "";
  const status = result?.results?.customers?.status;
  if (status === "error") return { done: true, error: result?.results?.customers?.error };
  if (note.includes("Stopped early") || note.includes("Stopped at")) return { done: false };
  if (checkpoint?.cursor) return { done: false };
  if (checkpoint?.last_completed_at) return { done: true };
  if (note.includes("Incremental window")) return { done: true };
  if (note.includes("Already up to date")) return { done: true };
  return { done: true };
}

let run = 0;
let totalSynced = 0;

console.log("Starting full customer resync (checkpoint resume loop)…");
if (reset) console.log("First batch will reset customer checkpoint.");

while (true) {
  run++;
  const started = Date.now();
  console.log(`\n--- Batch ${run} ---`);
  const result = await runBatch(reset && run === 1);
  const batch = result?.results?.customers;
  const synced = Number(batch?.synced || 0);
  totalSynced += synced;
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Synced this batch: ${synced} (${elapsed}s)`);
  if (batch?.note) console.log(`Note: ${batch.note}`);
  if (batch?.error) {
    console.error("Error:", batch.error);
    process.exit(1);
  }

  const checkpoint = await getCheckpoint();
  const { done, error } = isComplete(result, checkpoint);
  if (error) {
    console.error("Sync error:", error);
    process.exit(1);
  }
  if (done) {
    console.log(`\nCustomer resync complete after ${run} batch(es). Total rows touched: ${totalSynced}`);
    if (checkpoint?.last_completed_at) console.log(`Checkpoint completed at: ${checkpoint.last_completed_at}`);
    break;
  }

  console.log("Checkpoint saved — continuing next batch…");
  await new Promise((r) => setTimeout(r, 1500));
}
