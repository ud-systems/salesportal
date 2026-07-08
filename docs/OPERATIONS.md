# Operations — DataPulseFlow dependency

This runbook describes how the system behaves when DataPulseFlow is active, expiring, or unavailable. It is intended for operators, assessors, and on-call engineers.

---

## Normal operation

When everything is healthy:

1. A valid DataPulseFlow access code is stored in `app_settings` (`datapulse_access_code`, `datapulse_access_expires_at`, `datapulse_license_mode`).
2. Shopify credentials are configured in Settings.
3. Webhooks are registered to `https://<project-ref>.supabase.co/functions/v1/shopify-webhook`.
4. Shopify changes flow in via webhooks; manual or scheduled sync runs via `shopify-sync`.
5. Dashboards and analytics RPCs read current data from `shopify_*` tables.

---

## License validation flow

### On save (Settings UI)

1. Admin enters access code in **Settings → DataPulse License Code**.
2. App `POST`s code to `datapulse_validation_url` (DataPulseFlow-hosted `validate-access-code`).
3. On success, app persists `datapulse_access_code`, `datapulse_access_expires_at`, and `datapulse_license_mode` (`renewable` or `lifetime`).

### On every sync and webhook (server)

`shopify-sync` and `shopify-webhook` call `assertDataPulseLicenseActive()`:

1. Read license keys from `app_settings`.
2. Reject immediately if code is missing or locally expired (non-lifetime).
3. Re-validate against DataPulseFlow API on every request.
4. Reject if remote validation fails or expiry has passed.

### On manual sync (client)

`triggerSync()` in `use-shopify-data.ts` calls `assertLicenseActive()` before invoking the Edge Function, so users see a clear error without waiting for a server round-trip.

---

## Failure modes

### License expired or missing

| Symptom | Cause | User impact |
|---------|-------|-------------|
| Sync button errors | Client `assertLicenseActive()` | Cannot run manual sync |
| `shopify-sync` returns error | Server license check | Scheduled/cron sync fails |
| `shopify-webhook` returns error | Server license check | **No new webhook events ingested** |
| Admin dashboard banner | `AdminDashboardPage` license monitor | "License Expired - Sync Locked" or "Expires Soon" |
| Settings shows invalid state | Last validation failed | Prompt to enter new code |

**What still works:** Login, navigation, viewing **existing** Postgres rows (stale KPIs, old orders).

**What breaks:** All live commerce operations — new orders, customer updates, product changes, salesperson assignment updates from Shopify, financial refresh.

### Invalid or revoked code

Same as expired license. Remote validation returns `valid: false`; sync and webhooks stop immediately even if local expiry timestamp has not passed.

### Shopify credentials misconfigured

`shopify-test` can still run (no license gate). Sync and webhooks fail at Shopify API or HMAC verification layer. Distinct from license failure — check `sync_logs` and Edge Function logs.

### DataPulseFlow validation API unreachable

Sync and webhooks fail closed. The system does not bypass license checks. Retry after API recovery or contact DataPulseFlow support.

---

## Renewal procedure

1. Obtain a new access code via [DataPulseFlow guest checkout](https://datapulseflow.com).
2. Sign in as admin → **Settings** → **DataPulse License Code**.
3. Enter code → **Validate Code**.
4. Confirm success toast and updated expiry (or lifetime mode).
5. Trigger a manual sync or wait for the next scheduled run.
6. Verify `shopify_webhook_events` and `sync_logs` show recent activity.

Admin dashboard license banner clears automatically once a valid renewable license has more than 7 days remaining (or immediately for lifetime).

---

## Monitoring checklist

| Signal | Healthy | Investigate |
|--------|---------|-------------|
| `sync_logs` latest row | Recent `completed` status | License, Shopify token, or function deploy |
| `shopify_webhook_events` | New rows after Shopify changes | Webhook registration, license, HMAC secret |
| `app_settings.datapulse_access_expires_at` | Future date (or `lifetime` mode) | Renew via DataPulseFlow |
| Admin license banner | Hidden | Renew before sync lock |
| Dashboard KPIs vs Shopify admin | Match for current period | Stale data — sync likely stopped |

---

## Designed dependency

License enforcement is intentional. The application is licensed to operate with DataPulseFlow as the commerce data backbone. Disabling license checks would not restore Shopify connectivity — it would only remove compliance controls while leaving the system dependent on DataPulseFlow-provided schema, functions, and ingestion logic.

For architecture context see [ARCHITECTURE.md](./ARCHITECTURE.md). For component ownership see [DEPENDENCIES.md](./DEPENDENCIES.md).
