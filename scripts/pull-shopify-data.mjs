/**
 * Export Shopify-synced tables from the linked remote Supabase project to local JSONL files.
 * No Docker required — uses direct Postgres connection via credentials from `supabase link`.
 *
 * Usage:
 *   node scripts/pull-shopify-data.mjs
 *
 * Output:
 *   data/shopify-export/<table>.jsonl
 *   data/shopify-export/manifest.json
 */
import { execSync } from "child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "data", "shopify-export");
const BATCH = 5000;

const TABLES = [
  "shopify_customers",
  "shopify_products",
  "shopify_variants",
  "shopify_collections",
  "shopify_orders",
  "shopify_order_items",
  "shopify_order_fulfillments",
  "purchase_orders",
  "shopify_analytics_period_facts",
  "shopify_analytics_order_facts",
  "shopify_refund_events",
  "shopify_order_refund_deltas",
  "salesperson_customer_assignments",
];

function getLinkedDbConfig() {
  const dry = execSync("supabase db dump --dry-run --linked --data-only --schema public", {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const host = dry.match(/PGHOST="([^"]+)"/)?.[1];
  const port = Number(dry.match(/PGPORT="([^"]+)"/)?.[1] || "5432");
  const user = dry.match(/PGUSER="([^"]+)"/)?.[1] || "postgres";
  const password = dry.match(/PGPASSWORD="([^"]+)"/)?.[1];
  const database = dry.match(/PGDATABASE="([^"]+)"/)?.[1] || "postgres";
  if (!host || !password) {
    throw new Error("Could not read linked DB credentials. Run: supabase link --project-ref <ref>");
  }
  return { host, port, user, password, database };
}

async function exportTable(client, table) {
  const outPath = resolve(outDir, `${table}.jsonl`);
  const ws = createWriteStream(outPath);
  let total = 0;

  await client.query("BEGIN");
  await client.query(
    `DECLARE export_cursor CURSOR FOR SELECT row_to_json(t) AS row FROM public."${table}" AS t`,
  );
  try {
    while (true) {
      const { rows } = await client.query(`FETCH ${BATCH} FROM export_cursor`);
      if (rows.length === 0) break;
      for (const r of rows) ws.write(`${JSON.stringify(r.row)}\n`);
      total += rows.length;
      process.stdout.write(`\r  ${table}: ${total.toLocaleString()} rows`);
      if (rows.length < BATCH) break;
    }
  } finally {
    await client.query("COMMIT");
  }

  await new Promise((resolvePromise, reject) => {
    ws.end((err) => (err ? reject(err) : resolvePromise()));
  });

  console.log(`\r  ${table}: ${total.toLocaleString()} rows -> data/shopify-export/${table}.jsonl`);
  return total;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const cfg = getLinkedDbConfig();
  const client = new pg.Client({
    ...cfg,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000,
    statement_timeout: 0,
    query_timeout: 0,
  });

  console.log(`Connecting to ${cfg.host}...`);
  await client.connect();
  console.log(`Exporting ${TABLES.length} Shopify tables to ${outDir}\n`);

  const manifest = {
    exported_at: new Date().toISOString(),
    project_host: cfg.host,
    tables: {},
  };

  try {
    for (const table of TABLES) {
      manifest.tables[table] = { rows: await exportTable(client, table) };
    }
  } finally {
    await client.end();
  }

  writeFileSync(resolve(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const totalRows = Object.values(manifest.tables).reduce((n, t) => n + t.rows, 0);
  console.log(`\nDone. ${totalRows.toLocaleString()} total rows across ${TABLES.length} tables.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
