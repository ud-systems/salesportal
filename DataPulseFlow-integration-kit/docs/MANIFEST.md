# DataPulseFlow Integration Kit — file manifest

**Vendor:** DataPulseFlow — [DataPulseFlow.com](https://datapulseflow.com)  

```
DataPulseFlow-integration-kit/
├── README.md
├── LICENSE-NOTICE.txt
├── env.example
├── scripts/
│   └── register-shopify-webhooks.mjs
├── docs/
│   ├── DEPLOYMENT.md
│   ├── FRONTEND-INTEGRATION.md
│   ├── WEBHOOK-ENDPOINTS.md
│   └── MANIFEST.md
└── supabase/
    ├── config.toml
    ├── migrations/
    │   └── *.sql  (11 files — full schema + RLS + Shopify + sync + scheduler)
    └── functions/
        ├── _shared/
        │   ├── cors.ts
        │   ├── require-admin.ts
        │   ├── shopify-auth.ts
        │   └── shopify-credentials.ts
        ├── shopify-webhook/
        │   └── index.ts
        ├── shopify-sync/
        │   └── index.ts
        └── shopify-test/
            └── index.ts
```

**Not included (reference app only):** Vite/React UI, Playwright, marketing site, PayPal flows, `seed-users` function, `provision-salespeople.mjs`.
