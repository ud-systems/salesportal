# Unique Distribution Sales Portal

Internal web application for Unique Distribution sales and operations workflows.

## Core platform: DataPulseFlow

This application is built on **[DataPulseFlow](https://datapulseflow.com)** — the licensed Shopify data platform that provides all commerce ingestion for this system:

- **Edge Functions** — `shopify-webhook`, `shopify-sync`, `shopify-test`
- **Database schema** — `shopify_*` tables, sync checkpoints, webhook audit, assignments
- **License validation** — active access code required for sync and webhook ingestion

The React UI (`src/`) is the application layer. It does not connect to Shopify directly. All customers, orders, products, and analytics flow through DataPulseFlow into Postgres, then into dashboards.

**Without an active DataPulseFlow license, the business system stops** — webhooks and sync are locked, and data goes stale. See [docs/OPERATIONS.md](./docs/OPERATIONS.md).

| Document | Description |
|----------|-------------|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System design, data flow, component map |
| [docs/DEPENDENCIES.md](./docs/DEPENDENCIES.md) | What breaks if DataPulseFlow or other layers are removed |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | License renewal, failure modes, monitoring |
| [DataPulseFlow-integration-kit/](./DataPulseFlow-integration-kit/) | Vendor deliverable — source-of-truth for deployed `supabase/` integration |

**License:** DataPulseFlow integration is subject to [LICENSE-NOTICE.txt](./DataPulseFlow-integration-kit/LICENSE-NOTICE.txt).

## Stack

- **Frontend:** Vite, React, TanStack Query, Supabase JS
- **Backend:** Supabase (Postgres, Auth, Edge Functions)
- **Commerce data platform:** DataPulseFlow (Shopify sync + webhooks)
- **Source:** Shopify Admin API + webhooks

## Development Attribution

This codebase is developed and maintained by Ian Katana.
