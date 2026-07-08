# Dependencies

This document maps **external and platform dependencies** for the Unique Distribution Sales Portal. Use it during technical assessment, onboarding, or due diligence.

---

## Core platform dependency: DataPulseFlow

**[DataPulseFlow](https://datapulseflow.com)** is not an add-on or optional integration. It is the **Shopify data platform** this application is built on. The application layer (`src/`) is a client of DataPulseFlow-populated Postgres tables and Edge Functions.

| Component | Provider | Location in repo | If removed or inactive |
|-----------|----------|------------------|------------------------|
| Shopify webhook ingestion | DataPulseFlow | `supabase/functions/shopify-webhook` | No real-time order/customer/product updates |
| Shopify sync engine | DataPulseFlow | `supabase/functions/shopify-sync` | No manual or scheduled full/incremental sync |
| Connection test | DataPulseFlow | `supabase/functions/shopify-test` | Cannot validate Shopify credentials before save |
| Shared ingestion modules | DataPulseFlow | `supabase/functions/_shared/shopify-*.ts`, `salesperson-match.ts` | Sync and webhooks cannot compile or run |
| Commerce database schema | DataPulseFlow | `supabase/migrations/` (shopify_* tables) | Fresh deploy has no data model; app queries fail |
| License validation | DataPulseFlow API | `datapulse_validation_url` in `app_settings` | Sync and webhooks hard-stop (by design) |
| Vendor deliverable archive | DataPulseFlow | `DataPulseFlow-integration-kit/` | Loss of deployment docs, canonical migrations, and license terms |

**Bottom line:** Removing DataPulseFlow removes the entire Shopify → Postgres pipeline. The React UI has no independent path to commerce data.

---

## Infrastructure dependencies

| Service | Role | Required |
|---------|------|----------|
| **Supabase** | Postgres, Auth, Edge Functions, RLS | Yes |
| **Shopify** | Source of truth for customers, orders, products | Yes (for live data) |
| **DataPulseFlow license API** | Validates access codes; controls sync availability | Yes (for live data) |

---

## Application dependencies

| Layer | Technology | Depends on |
|-------|------------|------------|
| Frontend | Vite, React, TanStack Query, shadcn/ui | DataPulseFlow-populated `shopify_*` tables via Supabase client |
| Auth | Supabase Auth + `user_roles` | Independent of DataPulseFlow (login works without license) |
| Analytics | Postgres RPCs (`get_scope_shopify_analytics_dashboard`, etc.) | DataPulseFlow sync keeping `shopify_orders` and related tables current |

---

## Dependency chain (assessment view)

```
Shopify store
    │
    ├─ webhooks ──► DataPulseFlow shopify-webhook ──► Postgres
    │
    └─ Admin API ──► DataPulseFlow shopify-sync ─────► Postgres
                              │
                              ▼
                    License check (DataPulseFlow API)
                              │
                              ▼
                    React dashboards & analytics RPCs
```

**Stale-data caveat:** Dashboards can render **cached** rows from Postgres after license expiry, but the system is considered non-operational — no new orders, no assignment updates, no financial refresh. See [OPERATIONS.md](./OPERATIONS.md).

---

## License and legal

- DataPulseFlow integration is subject to [`DataPulseFlow-integration-kit/LICENSE-NOTICE.txt`](../DataPulseFlow-integration-kit/LICENSE-NOTICE.txt).
- Use of Edge Functions, migrations, and shared modules is licensed under agreement with DataPulseFlow.
- The `DataPulseFlow-integration-kit/` folder is the authoritative vendor package; `supabase/` is its deployed instance in this project.

---

## Related documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — full system design and data flow
- [OPERATIONS.md](./OPERATIONS.md) — runtime behavior when license or sync fails
- [`DataPulseFlow-integration-kit/docs/DEPLOYMENT.md`](../DataPulseFlow-integration-kit/docs/DEPLOYMENT.md) — deployment procedures
