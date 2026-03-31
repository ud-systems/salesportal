# DataPulseFlow — Frontend / app contract (reference)

**Vendor:** DataPulseFlow — [DataPulseFlow.com](https://datapulseflow.com)  

This kit ships **backend** assets only. A working product like the reference implementation also needs:

## Auth

- Supabase Auth with `user_roles` table and `admin` role (see migrations for `has_role`, policies).
- Edge Functions `shopify-sync` and `shopify-test` expect `Authorization: Bearer <user_access_token>` and an admin row in `user_roles`.

## Calling Edge Functions

- **Sync:** `POST` `shopify-sync` with JSON body `{ "module": "customers" | "orders" | ... }` optional; long timeout recommended.
- **Test:** `POST` `shopify-test` with body containing optional Shopify overrides for pre-save validation.

Refresh the session JWT before invoke if your gateway returns 401 (stale token pattern).

## Settings UI

- Read/write `app_settings` for all keys listed in `DEPLOYMENT.md`.
- Normalize domain and tokens on save (match client helpers in your app).

## Data UI

- Pages query PostgREST tables: `shopify_customers`, `shopify_orders`, `shopify_order_items`, `shopify_products`, `shopify_variants`, `shopify_collections`, `purchase_orders`, `sync_logs`, `shopify_webhook_events`, `salesperson_customer_assignments`, etc.

## Optional

- Webhook Monitor and Sync Logs pages with polling for near-real-time status.

Implementing the above on a **Vite + React + TanStack Query + Supabase JS** stack matches the reference architecture this kit was extracted from.
