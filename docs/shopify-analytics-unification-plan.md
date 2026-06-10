# Shopify Analytics Unification — Implementation Plan

**Goal:** One Shopify-aligned analytics model across all roles. No duplicate “CRM totals” vs “Shopify totals”. RPC-first; stable through ongoing sync.

## Verified root causes

| Issue | Cause |
|-------|--------|
| Dashboard totals drift after sync | `current_total` drops on **pending** orders without real refunds (e.g. `#UD17569`) |
| Two conflicting totals | `get_scope_shopify_sales_breakdown` vs `get_scope_financial_breakdown` |
| Gross sales ≠ Shopify | `reporting_line_items_gross` ≠ Shopify Analytics gross |
| False refund slice | `GREATEST(original_total − current_total, 0)` on pending orders |

## Shopify Analytics vocabulary (only names we use in UI)

| Label | Source |
|-------|--------|
| Gross sales | `reporting_line_items_gross` (fallback `subtotal`) |
| Discounts | `reporting_total_discounts` |
| Returns | `reporting_total_refunded` |
| Net sales | gross − discounts − returns |
| Shipping charges | `reporting_total_shipping` |
| Taxes | `total_tax` |
| **Total sales** | net + taxes + shipping (aligned with order `total` sum) |

## Refund rule (all RPCs + sync)

Returns/refund slice only when:
- `financial_status` ∈ refunded / partially_refunded, **or**
- `reporting_total_refunded > 0`

Never treat `original_total − current_total` alone as a return on **pending/authorized** orders.

## Phases

### Phase 1 — DB helpers + RPC fixes
- `shopify_order_effective_returns()` SQL helper
- `shopify_order_total_sales()` SQL helper
- Patch all financial/breakdown RPCs to use helpers

### Phase 2 — Unified dashboard RPC
- `get_scope_shopify_analytics_dashboard` (+ viewer / selected-salespeople variants)
- `get_scope_shopify_analytics_timeseries`

### Phase 3 — Sync guardrails
- Edge functions: don’t persist false `current_total` drops on pending orders without refund signal

### Phase 4 — Frontend (all roles)
- `useShopifyAnalyticsDashboard` hook
- `ShopifyAnalyticsSummaryCard` (rename from overview card)
- Remove collapsible **CRM order totals** (`RetailFinancialKpiSection` collapsible usage)
- Wire: Admin, Salesperson, Manager, Supervisor, Analytics, Salespersons

### Phase 5 — Validation
- SQL spot-check vs Shopify for 7 Jun 2026
- Lint / build

## Role coverage checklist

- [x] `AdminDashboardPage.tsx` — unified `DashboardOverviewSummaryCard` + `useShopifyAnalyticsDashboard`
- [x] `DashboardPage.tsx` (salesperson)
- [x] `ManagerDashboardPage.tsx` — team + selected-salespeople analytics hooks
- [x] `SupervisorDashboardPage.tsx` — all / drill / aggregate viewer hooks
- [x] `AnalyticsPage.tsx`
- [x] `SalespersonsPage.tsx` — Shopify column labels (Total sales, Net sales, Taxes, Returns)
- [x] `.cursor/rules/dashboard-consistency.mdc` aligned

## Implementation status (2026-06-08)

| Phase | Status | Notes |
|-------|--------|-------|
| 1 — DB helpers + RPC patch | **Files ready** | `20260608140000_shopify_analytics_unification.sql`, `20260608140100_patch_financial_rpcs_effective_totals.sql` |
| 2 — Unified dashboard RPC | **Done** | `get_scope_shopify_analytics_dashboard`, `get_selected_salespeople_shopify_analytics_dashboard` |
| 3 — Sync guardrails | **Done** | `shopify-order-totals.ts`, sync + graphql upsert |
| 4 — Frontend all roles | **Done** | `useShopifyAnalyticsDashboard`, CRM collapsible removed everywhere |
| 5 — Validation | **Deployed** | Migrations applied 2026-06-08; `#UD17569` backfilled; effective returns = 0 on 7 Jun |

### Migrations to deploy

```bash
# Requires SUPABASE_DB_PASSWORD or linked project
npx supabase db push
```

Or paste both migration files into the Supabase SQL editor.

### Post-deploy verification (7 Jun 2026)

```sql
SELECT total_sales, returns, orders_total
FROM get_scope_shopify_analytics_dashboard(
  '<admin-user-uuid>'::uuid,
  '2026-06-07T00:00:00+00'::timestamptz,
  '2026-06-07T23:59:59+00'::timestamptz
);
-- Expect total_sales ≈ 14862.56, returns = 0 (no false refund on #UD17569)
```

## Rollout

1. **Migration deploy** — pending (`supabase db push` needs DB password)
2. **Edge function deploy** — sync guard changes in `shopify-sync` / webhook upsert
3. **Frontend deploy** — ready (`npm run build` passes)
4. **One-time backfill** — included in migration UPDATE on pending orders
