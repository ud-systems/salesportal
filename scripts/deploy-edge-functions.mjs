/**
 * Deploy edge functions via Supabase Management API.
 * Requires: SUPABASE_ACCESS_TOKEN (from `supabase login`) in env or .env
 *
 * Usage:
 *   node scripts/deploy-edge-functions.mjs shopify-webhook
 *   node scripts/deploy-edge-functions.mjs shopify-sync
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m || process.env[m[1].trim()]) continue;
    process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const fnName = process.argv[2];
if (!fnName) {
  console.error("Usage: node scripts/deploy-edge-functions.mjs <shopify-webhook|shopify-sync>");
  process.exit(1);
}

const jsonPath = resolve(root, `agent-tools/deploy-${fnName === "shopify-webhook" ? "webhook" : "sync"}.json`);
const files = JSON.parse(readFileSync(jsonPath, "utf8"));
const projectRef = process.env.SUPABASE_PROJECT_REF || "xbmpndatdanjewhwxzxr";
const token = process.env.SUPABASE_ACCESS_TOKEN || "";

if (!token) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run: npx supabase login");
  process.exit(1);
}

const metadata = JSON.stringify({
  entrypoint_path: `${fnName}/index.ts`,
  name: fnName,
  verify_jwt: false,
});

const form = new FormData();
form.append("metadata", metadata);
for (const file of files) {
  form.append("file", new Blob([file.content], { type: "text/plain" }), file.name);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/functions/deploy?slug=${fnName}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
const text = await res.text();
console.log(res.status, text.slice(0, 2000));
process.exit(res.ok ? 0 : 1);
