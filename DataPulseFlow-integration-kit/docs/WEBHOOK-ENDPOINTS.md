# DataPulseFlow — Webhook endpoints (client deliverable)

**Vendor:** DataPulseFlow — [DataPulseFlow.com](https://datapulseflow.com)  

After deployment, your **Shopify Admin API** webhooks should point to:

## Ingestion URL (HTTPS POST, JSON)

```
https://<YOUR_SUPABASE_PROJECT_REF>.supabase.co/functions/v1/shopify-webhook
```

Replace `<YOUR_SUPABASE_PROJECT_REF>` with your Supabase project reference (Dashboard → Settings → API).

## Subscribed topics (6)

| Shopify topic        | Purpose                          |
|---------------------|----------------------------------|
| `CUSTOMERS_CREATE`  | New customer → DB upsert         |
| `CUSTOMERS_UPDATE`  | Customer changes → DB upsert   |
| `ORDERS_CREATE`     | New order → DB upsert          |
| `ORDERS_UPDATED`    | Order changes → DB upsert      |
| `PRODUCTS_CREATE`   | New product → DB upsert        |
| `PRODUCTS_UPDATE`   | Product changes → DB upsert    |

## Registration

Use the included script `scripts/register-shopify-webhooks.mjs` (with `SUPABASE_PROJECT_REF` set), or create equivalent subscriptions in Shopify Admin / GraphQL Admin API.

## Security

- Shopify sends `X-Shopify-Hmac-Sha256`; the function verifies it using `shopify_webhook_secret` from `app_settings` (or `SHOPIFY_WEBHOOK_SECRET` env).
- The handler checks `X-Shopify-Shop-Domain` matches the configured store domain.
