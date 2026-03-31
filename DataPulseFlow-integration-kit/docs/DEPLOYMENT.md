# DataPulseFlow — Deployment guide

**Vendor:** DataPulseFlow — [DataPulseFlow.com](https://datapulseflow.com)  

Target stack: **Supabase** (Postgres + Row Level Security + Edge Functions) + **Shopify** custom app (Admin API).  
Host app (e.g. React/Vite) must implement admin auth, `app_settings` UI, and `supabase.functions.invoke` for sync — see `FRONTEND-INTEGRATION.md`.

## 1. Prerequisites

- Supabase project
- Shopify store + custom app with Admin API access token (`shpat_…`) and required scopes for customers, orders, products, collections, inventory as needed
- Supabase CLI logged in (`supabase login`)

## 2. Database migrations

Apply SQL migrations in `supabase/migrations/` **in filename order** (timestamp prefixes preserve order).

**Before applying** `20260326100000_shopify_reconcile_scheduler.sql`:

1. Open the file and replace `YOUR_SUPABASE_PROJECT_REF` in the `net.http_post` URL with your real project ref (same as in Supabase URL).

2. After first deploy of `shopify-sync`, set Edge Function secret `SHOPIFY_CRON_SECRET` to a strong random value and store the same value in `app_settings` under key `shopify_cron_secret` (the migration inserts a UUID if missing; align secret in Dashboard with your operational choice).

## 3. Edge Functions

Copy `supabase/functions/` contents into your repo’s `supabase/functions/` (or deploy from this kit directory):

- `shopify-webhook` — public to Shopify; verify JWT **off** in Dashboard/config
- `shopify-sync` — admin JWT + optional `x-shopify-cron-secret` for scheduler
- `shopify-test` — admin JWT connection test
- `_shared/` — required by all three

Deploy:

```bash
supabase functions deploy shopify-webhook --project-ref YOUR_REF --no-verify-jwt
supabase functions deploy shopify-sync --project-ref YOUR_REF --no-verify-jwt
supabase functions deploy shopify-test --project-ref YOUR_REF --no-verify-jwt
```

Match `[functions.*] verify_jwt = false` in `supabase/config.toml` or Dashboard settings.

## 4. `app_settings` keys

| Key | Purpose |
|-----|---------|
| `shopify_store_domain` | `store.myshopify.com` |
| `shopify_access_token` | Admin API token `shpat_…` |
| `shopify_client_id` / `shopify_client_secret` | Optional; enables token refresh |
| `shopify_access_token_expires_at` | Set by refresh flow |
| `shopify_webhook_secret` | HMAC signing secret (typically app client secret) |
| `sync_frequency` | `manual`, `15min`, `30min`, `1hour`, `6hour`, `12hour`, `daily` |
| `shopify_cron_secret` | Must match `SHOPIFY_CRON_SECRET` for scheduled sync |

## 5. Register Shopify webhooks

```bash
set SUPABASE_PROJECT_REF=your_ref
node scripts/register-shopify-webhooks.mjs
```

Requires Supabase CLI to resolve service role key (`npx supabase projects api-keys`).

## 6. Verify

- Run `shopify-test` from your app with admin session.
- Trigger a test webhook or change a product in Shopify; check `shopify_webhook_events` and target tables.
