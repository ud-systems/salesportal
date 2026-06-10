import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(resolve(root, "scripts/.period-facts-upserts.json"), "utf8");
const i = raw.indexOf("[");
const rows = JSON.parse(raw.slice(i));

const vals = rows
  .map(
    (r) =>
      `('${r.reporting_day}',${r.gross_sales},${r.discounts},${Math.abs(r.returns_refunded)},${r.net_sales},${r.shipping_charges},0,${r.taxes},${r.total_sales},${r.orders_count},now())`,
  )
  .join(",\n");

const sql = `INSERT INTO shopify_analytics_period_facts (reporting_day,gross_sales,discounts,returns_refunded,net_sales,shipping_charges,return_fees,taxes,total_sales,orders_count,synced_at) VALUES
${vals}
ON CONFLICT (reporting_day) DO UPDATE SET gross_sales=EXCLUDED.gross_sales,discounts=EXCLUDED.discounts,returns_refunded=EXCLUDED.returns_refunded,net_sales=EXCLUDED.net_sales,shipping_charges=EXCLUDED.shipping_charges,return_fees=EXCLUDED.return_fees,taxes=EXCLUDED.taxes,total_sales=EXCLUDED.total_sales,orders_count=EXCLUDED.orders_count,synced_at=EXCLUDED.synced_at;`;

writeFileSync(resolve(root, "scripts/.period-facts-upsert.sql"), sql);
const today = rows.find((r) => r.reporting_day === "2026-06-09");
console.log("rows", rows.length, "today", today);
