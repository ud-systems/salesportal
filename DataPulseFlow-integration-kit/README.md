# DataPulseFlow Integration Kit

**Version:** 1.0.0 (bundle extracted for licensees)  
**Vendor:** DataPulseFlow  
**Domain:** [DataPulseFlow.com](https://datapulseflow.com)  

This package contains the **server-side integration layer** that enables a Supabase-backed application—structured like the reference implementation—to **sync and ingest Shopify data** via **Admin GraphQL**, **webhooks**, **checkpoints**, and **optional scheduled reconciliation**.

It is **not** a drop-in for arbitrary stacks. It requires **Supabase** (Postgres + Edge Functions) and a **Shopify custom app** with appropriate Admin API scopes.

---

## What you receive

| Component | Description |
|-----------|-------------|
| **Edge Functions** | `shopify-webhook`, `shopify-sync`, `shopify-test` + `_shared` modules |
| **Database migrations** | Schema for Shopify entities, `app_settings`, `sync_logs`, `sync_checkpoints`, webhook audit table, RLS, assignments, pg_cron reconcile (with placeholder URL) |
| **Webhook registration script** | Node script to create the 6 standard webhook subscriptions |
| **Documentation** | Deployment, webhook URL template, frontend contract |

---

## Quick start

1. Read `docs/DEPLOYMENT.md`.
2. Replace **`YOUR_SUPABASE_PROJECT_REF`** in `supabase/migrations/20260326100000_shopify_reconcile_scheduler.sql` before applying.
3. Apply all files under `supabase/migrations/` in order.
4. Deploy functions under `supabase/functions/` with `--no-verify-jwt` as documented.
5. Configure `app_settings` and Edge secrets per `docs/DEPLOYMENT.md`.
6. Run `scripts/register-shopify-webhooks.mjs` with `SUPABASE_PROJECT_REF` set (see `env.example`).
7. Give clients the canonical webhook URL and topic list from `docs/WEBHOOK-ENDPOINTS.md`.

---

## Deliverable summary for customers

- **Webhook ingestion endpoint:**  
  `https://<project-ref>.supabase.co/functions/v1/shopify-webhook`
- **Six webhook topics:** customers create/update, orders create/updated, products create/update (see `docs/WEBHOOK-ENDPOINTS.md`).
- **Sync engine:** `shopify-sync` (full multi-module sync + cron header support).
- **Connectivity test:** `shopify-test`.

---

## License

See `LICENSE-NOTICE.txt`. Use only under your agreement with DataPulseFlow.

---

## Packaging for download

Zip this entire `DataPulseFlow-integration-kit` folder (or the archive you distribute). Do not include your production `.env` or service role keys.
