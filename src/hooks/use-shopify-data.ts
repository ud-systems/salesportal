/**
 * Shopify data hooks — client of the DataPulseFlow platform.
 * All commerce tables (`shopify_*`) are populated by DataPulseFlow Edge Functions.
 * Manual sync invokes `shopify-sync` and requires an active DataPulseFlow license.
 * @see docs/ARCHITECTURE.md
 */
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { getAccessTokenForEdgeFunctions } from "@/lib/supabase-edge-auth";
import { devError, devInfo } from "@/lib/dev-logger";
import {
  storeDayEndExclusiveIsoFromYmd,
  storeDayStartIsoFromYmd,
  storeTimeseriesBucket,
  SHOPIFY_REPORTING_TIMEZONE,
} from "@/lib/shopify-reporting-timezone";
import { useQuery } from "@tanstack/react-query";

export type SalespersonPerformanceRow = {
  salesperson_user_id: string;
  salesperson_name: string;
  customers_count: number;
  orders_count: number;
  revenue: number;
};

export type ViewerScopePerformanceRow = {
  viewer_user_id: string;
  viewer_role: string | null;
  team_member_count: number;
  team_customers_count: number;
  team_orders_count: number;
  team_revenue: number;
};

export type ScopeOrderMetrics = {
  orders_count: number;
  customers_count: number;
  revenue: number;
  avg_order_value: number;
};

export type ScopeFinancialBreakdown = {
  customers_count: number;
  orders_total_count: number;
  orders_paid_count: number;
  orders_pending_count: number;
  orders_refunded_count: number;
  original_gross_sales: number;
  current_gross_sales: number;
  net_sales_ex_vat: number;
  vat_collected: number;
  refunded_returned_value: number;
  avg_order_original_gross: number;
  avg_order_current_gross: number;
  avg_order_net_ex_vat: number;
  /** Orders with NULL current_total (post-return total not synced); gross/net match until sync backfills. */
  orders_missing_current_total: number;
};

/** Layer 2: Shopify Analytics–style components from `reporting_*` columns (see get_scope_shopify_sales_breakdown). */
export type ScopeShopifySalesBreakdown = {
  gross_sales_line_list: number;
  discounts: number;
  returns_refunded: number;
  net_sales_derived: number;
  shipping: number;
  return_fees: number;
  taxes: number;
  total_sales_check: number;
  orders_in_scope: number;
  /** Non-void orders where reporting_line_items_gross is still null (re-sync to backfill). */
  orders_missing_reporting: number;
};

export function emptyScopeShopifySalesBreakdown(): ScopeShopifySalesBreakdown {
  return {
    gross_sales_line_list: 0,
    discounts: 0,
    returns_refunded: 0,
    net_sales_derived: 0,
    shipping: 0,
    return_fees: 0,
    taxes: 0,
    total_sales_check: 0,
    orders_in_scope: 0,
    orders_missing_reporting: 0,
  };
}

function mapScopeShopifySalesBreakdownRow(row: Partial<ScopeShopifySalesBreakdown> | undefined | null): ScopeShopifySalesBreakdown {
  return {
    gross_sales_line_list: Number(row?.gross_sales_line_list ?? 0),
    discounts: Number(row?.discounts ?? 0),
    returns_refunded: Number(row?.returns_refunded ?? 0),
    net_sales_derived: Number(row?.net_sales_derived ?? 0),
    shipping: Number(row?.shipping ?? 0),
    return_fees: Number(row?.return_fees ?? 0),
    taxes: Number(row?.taxes ?? 0),
    total_sales_check: Number(row?.total_sales_check ?? 0),
    orders_in_scope: Number(row?.orders_in_scope ?? 0),
    orders_missing_reporting: Number(row?.orders_missing_reporting ?? 0),
  };
}

/** Unified Shopify Analytics dashboard row (get_scope_shopify_analytics_dashboard). */
export type ShopifyAnalyticsDashboard = {
  gross_sales: number;
  discounts: number;
  returns: number;
  net_sales: number;
  shipping_charges: number;
  return_fees: number;
  taxes: number;
  total_sales: number;
  orders_total: number;
  orders_paid: number;
  orders_pending: number;
  orders_refunded: number;
  orders_unfulfilled: number;
  customers_count: number;
  average_order_value: number;
  orders_missing_reporting: number;
};

export function emptyShopifyAnalyticsDashboard(): ShopifyAnalyticsDashboard {
  return {
    gross_sales: 0,
    discounts: 0,
    returns: 0,
    net_sales: 0,
    shipping_charges: 0,
    return_fees: 0,
    taxes: 0,
    total_sales: 0,
    orders_total: 0,
    orders_paid: 0,
    orders_pending: 0,
    orders_refunded: 0,
    orders_unfulfilled: 0,
    customers_count: 0,
    average_order_value: 0,
    orders_missing_reporting: 0,
  };
}

function mapShopifyAnalyticsDashboardRow(
  row: Partial<ShopifyAnalyticsDashboard> | undefined | null,
): ShopifyAnalyticsDashboard {
  return {
    gross_sales: Number(row?.gross_sales ?? 0),
    discounts: Number(row?.discounts ?? 0),
    returns: Number(row?.returns ?? 0),
    net_sales: Number(row?.net_sales ?? 0),
    shipping_charges: Number(row?.shipping_charges ?? 0),
    return_fees: Number(row?.return_fees ?? 0),
    taxes: Number(row?.taxes ?? 0),
    total_sales: Number(row?.total_sales ?? 0),
    orders_total: Number(row?.orders_total ?? 0),
    orders_paid: Number(row?.orders_paid ?? 0),
    orders_pending: Number(row?.orders_pending ?? 0),
    orders_refunded: Number(row?.orders_refunded ?? 0),
    orders_unfulfilled: Number(row?.orders_unfulfilled ?? 0),
    customers_count: Number(row?.customers_count ?? 0),
    average_order_value: Number(row?.average_order_value ?? 0),
    orders_missing_reporting: Number(row?.orders_missing_reporting ?? 0),
  };
}

/** Map unified dashboard row to legacy breakdown shape for DashboardOverviewSummaryCard. */
export function shopifyAnalyticsToSalesBreakdown(d: ShopifyAnalyticsDashboard): ScopeShopifySalesBreakdown {
  return {
    gross_sales_line_list: d.gross_sales,
    discounts: d.discounts,
    returns_refunded: d.returns,
    net_sales_derived: d.net_sales,
    shipping: d.shipping_charges,
    return_fees: d.return_fees,
    taxes: d.taxes,
    total_sales_check: d.total_sales,
    orders_in_scope: d.orders_total,
    orders_missing_reporting: d.orders_missing_reporting,
  };
}

export function useShopifyAnalyticsDashboard(
  viewerUserId: string | undefined,
  fromIso?: string | null,
  toIso?: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["shopify-analytics-dashboard", viewerUserId ?? "none", fromIso ?? "all", toIso ?? "all"],
    queryFn: async () => {
      if (!viewerUserId) return emptyShopifyAnalyticsDashboard();
      const { data, error } = await (supabase as any).rpc("get_scope_shopify_analytics_dashboard", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      return mapShopifyAnalyticsDashboardRow(data?.[0]);
    },
    staleTime: 10_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    enabled: enabled && Boolean(viewerUserId),
  });
}

/** Aggregate Shopify Analytics for multiple viewer scopes (supervisor manager-team rollups). */
export function useAggregateShopifyAnalyticsDashboardForViewers(
  viewerUserIds: string[],
  fromIso?: string | null,
  toIso?: string | null,
  scopeKey = "global",
  enabled = true,
) {
  const idsKey = [...viewerUserIds].sort().join(",");
  return useQuery({
    queryKey: [
      "aggregate-shopify-analytics-dashboard-for-viewers",
      scopeKey,
      idsKey,
      fromIso ?? "all",
      toIso ?? "all",
    ],
    queryFn: async () => {
      if (!viewerUserIds.length) return emptyShopifyAnalyticsDashboard();
      const [bdRes, finRes] = await Promise.all([
        supabase.rpc("get_scope_shopify_sales_breakdown_for_viewers", {
          _viewer_user_ids: viewerUserIds,
          _from_iso: fromIso ?? null,
          _to_iso: toIso ?? null,
        }),
        (supabase as any).rpc("get_scope_financial_breakdown_for_viewers", {
          _viewer_user_ids: viewerUserIds,
          _from_iso: fromIso ?? null,
          _to_iso: toIso ?? null,
        }),
      ]);
      if (bdRes.error) throw bdRes.error;
      if (finRes.error) throw finRes.error;
      const bd = mapScopeShopifySalesBreakdownRow(bdRes.data?.[0]);
      const fin = finRes.data?.[0] as Partial<ScopeFinancialBreakdown> | undefined;
      const ordersTotal = Number(bd.orders_in_scope ?? 0);
      const totalSales = Number(bd.total_sales_check ?? 0);
      return mapShopifyAnalyticsDashboardRow({
        gross_sales: bd.gross_sales_line_list,
        discounts: bd.discounts,
        returns: bd.returns_refunded,
        net_sales: bd.net_sales_derived,
        shipping_charges: bd.shipping,
        return_fees: bd.return_fees,
        taxes: bd.taxes,
        total_sales: totalSales,
        orders_total: ordersTotal,
        orders_paid: fin?.orders_paid_count,
        orders_pending: fin?.orders_pending_count,
        orders_refunded: fin?.orders_refunded_count,
        orders_unfulfilled: 0,
        customers_count: fin?.customers_count,
        average_order_value: ordersTotal > 0 ? totalSales / ordersTotal : 0,
        orders_missing_reporting: bd.orders_missing_reporting,
      });
    },
    staleTime: 60_000,
    enabled: enabled && viewerUserIds.length > 0,
  });
}

export function useSelectedSalespeopleShopifyAnalyticsDashboard(
  viewerUserId: string | undefined,
  salespersonUserIds: string[],
  fromIso?: string | null,
  toIso?: string | null,
  enabled = true,
) {
  const idsKey = [...salespersonUserIds].sort().join(",");
  return useQuery({
    queryKey: [
      "selected-salespeople-shopify-analytics-dashboard",
      viewerUserId ?? "none",
      idsKey,
      fromIso ?? "all",
      toIso ?? "all",
    ],
    queryFn: async () => {
      if (!viewerUserId || !salespersonUserIds.length) return emptyShopifyAnalyticsDashboard();
      const { data, error } = await (supabase as any).rpc("get_selected_salespeople_shopify_analytics_dashboard", {
        _viewer_user_id: viewerUserId,
        _salesperson_user_ids: salespersonUserIds,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      return mapShopifyAnalyticsDashboardRow(data?.[0]);
    },
    staleTime: 60_000,
    enabled: enabled && Boolean(viewerUserId) && salespersonUserIds.length > 0,
  });
}

export type AnalyticsOverviewKpis = {
  active_buyers_count: number;
  registrations_count: number;
};

export type AnalyticsRfmGroupRow = {
  rfm_group: string;
  customers_count: number;
  active_buyers_count: number;
  revenue: number;
};

export type AnalyticsRfmMatrixCell = {
  recency_score: number;
  fm_score: number;
  customers_count: number;
};

export type SalespersonFinancialBreakdownRow = {
  salesperson_user_id: string;
  salesperson_name: string;
  customers_count: number;
  orders_total_count: number;
  orders_paid_count: number;
  orders_pending_count: number;
  orders_refunded_count: number;
  original_gross_sales: number;
  current_gross_sales: number;
  net_sales_ex_vat: number;
  vat_collected: number;
  refunded_returned_value: number;
  avg_order_original_gross: number;
  avg_order_current_gross: number;
  avg_order_net_ex_vat: number;
};

export type TimeseriesPoint = {
  label: string;
  revenue: number;
  orders: number;
};

/** Scoped salesperson metrics from get_selected_salespeople_scope_metrics_timeseries (aligns with ScopeFinancialBreakdown). */
export type SalespeopleScopedFinancialMetrics = {
  orders_count: number;
  customers_count: number;
  /** Same as current_gross_sales (Shopify current totals); kept for callers using `revenue`. */
  revenue: number;
  avg_order_value: number;
  orders_total_count: number;
  orders_paid_count: number;
  orders_pending_count: number;
  orders_refunded_count: number;
  original_gross_sales: number;
  current_gross_sales: number;
  net_sales_ex_vat: number;
  vat_collected: number;
  refunded_returned_value: number;
  avg_order_original_gross: number;
  avg_order_current_gross: number;
  avg_order_net_ex_vat: number;
  orders_missing_current_total: number;
  series: TimeseriesPoint[];
};

export type TeamMemberOption = {
  user_id: string;
  label: string;
};

export type SupervisorManagerSelfPerformanceRow = {
  manager_user_id: string;
  manager_name: string;
  customers_count: number;
  orders_count: number;
  revenue: number;
};

export type ShopifyOriginalTotalSyncHealth =
  | { status: "ready" }
  | { status: "migration_required"; message: string }
  | { status: "needs_resync"; missing: number; total: number };

/**
 * Detects whether refund KPIs can align with Shopify: `original_total` column + populated values from sync/webhooks.
 */
export function useShopifyOriginalTotalSyncHealth(enabled: boolean) {
  return useQuery({
    queryKey: ["shopify-original-total-sync-health"],
    staleTime: 120_000,
    enabled,
    queryFn: async (): Promise<ShopifyOriginalTotalSyncHealth> => {
      const nonTest = () =>
        supabase.from("shopify_orders").select("id", { count: "exact", head: true }).or("test_order.is.null,test_order.eq.false");

      const { count: total, error: e1 } = await nonTest();
      if (e1) throw e1;

      const { count: missing, error: e2 } = await nonTest().is("original_total", null);
      if (e2) {
        const msg = [e2.message, (e2 as { details?: string }).details].filter(Boolean).join(" ");
        if (/original_total|schema cache|does not exist/i.test(msg)) {
          return { status: "migration_required", message: msg || e2.message };
        }
        throw e2;
      }

      const t = total ?? 0;
      const m = missing ?? 0;
      if (t === 0 || m === 0) return { status: "ready" };
      return { status: "needs_resync", missing: m, total: t };
    },
  });
}

async function withQueryTiming<T>(
  label: string,
  context: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await run();
    const elapsedMs = Math.round(performance.now() - start);
    devInfo("[query:ok]", label, { elapsedMs, ...context });
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - start);
    devError("[query:error]", label, { elapsedMs, ...context, error });
    throw error;
  }
}

export type RecentCustomerOrder = {
  id: string;
  order_number: string | null;
  shopify_order_id: string;
  customer_id: string | null;
  shopify_customer_id: string | null;
  customer_name: string | null;
  email: string | null;
  total: number | null;
  subtotal: number | null;
  total_tax: number | null;
  currency_code: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  processed_at: string | null;
  shopify_created_at: string | null;
  created_at: string | null;
  tags: string | null;
  order_note: string | null;
};

export type OrderFulfillment = {
  id: string;
  order_id: string;
  shopify_fulfillment_id: string;
  shipment_status: string | null;
  tracking_company: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  fulfilled_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

async function fetchAllScopedCustomerIdsForViewer(
  viewerUserId: string,
  salespersonUserIds: string[],
): Promise<string[]> {
  const pageSize = 1000;
  let offset = 0;
  const ids = new Set<string>();
  while (true) {
    const { data, error } = await (supabase as any).rpc("get_scoped_customer_ids_for_salespeople_paged", {
        _viewer_user_id: viewerUserId,
        _salesperson_user_ids: salespersonUserIds,
        _offset: offset,
        _limit: pageSize,
      });
    if (error) throw error;
    const rows = (data ?? []) as { customer_id: string }[];
    for (const row of rows) {
      if (row.customer_id) ids.add(row.customer_id);
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return Array.from(ids);
}

async function fetchAllScopedOrderIdsForViewer(
  viewerUserId: string,
  salespersonUserIds: string[],
): Promise<string[]> {
  const pageSize = 1000;
  let offset = 0;
  const ids = new Set<string>();
  while (true) {
    const { data, error } = await (supabase as any).rpc("get_scoped_order_ids_for_salespeople_paged", {
        _viewer_user_id: viewerUserId,
        _salesperson_user_ids: salespersonUserIds,
        _offset: offset,
        _limit: pageSize,
      });
    if (error) throw error;
    const rows = (data ?? []) as { order_id: string }[];
    for (const row of rows) {
      if (row.order_id) ids.add(row.order_id);
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return Array.from(ids);
}

export function useScopeOrderMetrics(
  viewerUserId: string | undefined,
  fromIso?: string | null,
  toIso?: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["scope-order-metrics", viewerUserId ?? "none", fromIso ?? "all", toIso ?? "all"],
    queryFn: async () => withQueryTiming("get_scope_order_metrics", { viewerUserId, fromIso: fromIso ?? null, toIso: toIso ?? null }, async () => {
      if (!viewerUserId) {
        return { orders_count: 0, customers_count: 0, revenue: 0, avg_order_value: 0 } satisfies ScopeOrderMetrics;
      }
      const { data, error } = await supabase.rpc("get_scope_order_metrics", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) {
        // Keep dashboards usable even if backend RPC temporarily fails.
        devError("get_scope_order_metrics failed", error);
        return { orders_count: 0, customers_count: 0, revenue: 0, avg_order_value: 0 } satisfies ScopeOrderMetrics;
      }
      const row = (data?.[0] ?? {}) as Partial<ScopeOrderMetrics>;
      return {
        orders_count: Number(row.orders_count || 0),
        customers_count: Number(row.customers_count || 0),
        revenue: Number(row.revenue || 0),
        avg_order_value: Number(row.avg_order_value || 0),
      } satisfies ScopeOrderMetrics;
    }),
    staleTime: 60_000,
    enabled: enabled && Boolean(viewerUserId),
  });
}

export function useScopeFinancialBreakdown(
  viewerUserId: string | undefined,
  fromIso?: string | null,
  toIso?: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["scope-financial-breakdown", viewerUserId ?? "none", fromIso ?? "all", toIso ?? "all"],
    queryFn: async () => withQueryTiming("get_scope_financial_breakdown", { viewerUserId, fromIso: fromIso ?? null, toIso: toIso ?? null }, async () => {
      if (!viewerUserId) {
        return {
          customers_count: 0,
          orders_total_count: 0,
          orders_paid_count: 0,
          orders_pending_count: 0,
          orders_refunded_count: 0,
          original_gross_sales: 0,
          current_gross_sales: 0,
          net_sales_ex_vat: 0,
          vat_collected: 0,
          refunded_returned_value: 0,
          avg_order_original_gross: 0,
          avg_order_current_gross: 0,
          avg_order_net_ex_vat: 0,
          orders_missing_current_total: 0,
        } satisfies ScopeFinancialBreakdown;
      }
      const { data, error } = await supabase.rpc("get_scope_financial_breakdown", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      const row = (data?.[0] ?? {}) as Partial<ScopeFinancialBreakdown>;
      return {
        customers_count: Number(row.customers_count || 0),
        orders_total_count: Number(row.orders_total_count || 0),
        orders_paid_count: Number(row.orders_paid_count || 0),
        orders_pending_count: Number(row.orders_pending_count || 0),
        orders_refunded_count: Number(row.orders_refunded_count || 0),
        original_gross_sales: Number(row.original_gross_sales || 0),
        current_gross_sales: Number(row.current_gross_sales || 0),
        net_sales_ex_vat: Number(row.net_sales_ex_vat || 0),
        vat_collected: Number(row.vat_collected || 0),
        refunded_returned_value: Number(row.refunded_returned_value || 0),
        avg_order_original_gross: Number(row.avg_order_original_gross || 0),
        avg_order_current_gross: Number(row.avg_order_current_gross || 0),
        avg_order_net_ex_vat: Number(row.avg_order_net_ex_vat || 0),
        orders_missing_current_total: Number(row.orders_missing_current_total ?? 0),
      } satisfies ScopeFinancialBreakdown;
    }),
    staleTime: 60_000,
    enabled: enabled && Boolean(viewerUserId),
  });
}

export function useScopeShopifySalesBreakdown(
  viewerUserId: string | undefined,
  fromIso?: string | null,
  toIso?: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["scope-shopify-sales-breakdown", viewerUserId ?? "none", fromIso ?? "all", toIso ?? "all"],
    queryFn: async () =>
      withQueryTiming("get_scope_shopify_sales_breakdown", { viewerUserId, fromIso: fromIso ?? null, toIso: toIso ?? null }, async () => {
        if (!viewerUserId) {
          return emptyScopeShopifySalesBreakdown();
        }
        const { data, error } = await supabase.rpc("get_scope_shopify_sales_breakdown", {
          _viewer_user_id: viewerUserId,
          _from_iso: fromIso ?? null,
          _to_iso: toIso ?? null,
        });
        if (error) throw error;
        return mapScopeShopifySalesBreakdownRow(data?.[0]);
      }),
    staleTime: 60_000,
    enabled: enabled && Boolean(viewerUserId),
  });
}

/** Layer 2 aggregated for customers tied to specific salesperson user IDs (manager/supervisor salesperson mode). */
export function useSelectedSalespeopleShopifySalesBreakdown(
  viewerUserId: string | undefined,
  salespersonUserIds: string[],
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "selected-salespeople-shopify-sales-breakdown",
      viewerUserId ?? "none",
      fromIso ?? "none",
      toIso ?? "none",
      [...salespersonUserIds].sort().join(","),
    ],
    queryFn: async () =>
      withQueryTiming(
        "get_selected_salespeople_shopify_sales_breakdown",
        { viewerUserId, salespersonCount: salespersonUserIds.length, fromIso: fromIso ?? null, toIso: toIso ?? null },
        async () => {
          if (!viewerUserId || !salespersonUserIds.length) return emptyScopeShopifySalesBreakdown();
          const { data, error } = await supabase.rpc("get_selected_salespeople_shopify_sales_breakdown", {
            _viewer_user_id: viewerUserId,
            _salesperson_user_ids: salespersonUserIds,
            _from_iso: fromIso ?? null,
            _to_iso: toIso ?? null,
          });
          if (error) throw error;
          return mapScopeShopifySalesBreakdownRow(data?.[0]);
        },
      ),
    staleTime: 60_000,
    enabled: enabled && Boolean(viewerUserId) && salespersonUserIds.length > 0,
  });
}

/** Sum of per-viewer Layer 2 (matches get_scope_financial_breakdown_for_viewers aggregation). */
export function useAggregateShopifySalesBreakdownForViewers(
  viewerUserIds: string[],
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "aggregate-shopify-sales-breakdown-for-viewers",
      scopeKey,
      fromIso ?? "none",
      toIso ?? "none",
      [...viewerUserIds].sort().join(","),
    ],
    queryFn: async () => {
      if (!viewerUserIds.length) return emptyScopeShopifySalesBreakdown();
      const { data, error } = await supabase.rpc("get_scope_shopify_sales_breakdown_for_viewers", {
        _viewer_user_ids: viewerUserIds,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      return mapScopeShopifySalesBreakdownRow(data?.[0]);
    },
    staleTime: 60_000,
    enabled: enabled && viewerUserIds.length > 0,
  });
}

export function useAnalyticsOverviewKpis(
  viewerUserId: string | undefined,
  fromIso?: string | null,
  toIso?: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["analytics-overview-kpis", viewerUserId ?? "none", fromIso ?? "all", toIso ?? "all"],
    queryFn: async () => withQueryTiming("get_analytics_overview_kpis", { viewerUserId, fromIso: fromIso ?? null, toIso: toIso ?? null }, async () => {
      if (!viewerUserId) {
        return { active_buyers_count: 0, registrations_count: 0 } satisfies AnalyticsOverviewKpis;
      }
      const { data, error } = await (supabase as any).rpc("get_analytics_overview_kpis", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      const row = (data?.[0] ?? {}) as Partial<AnalyticsOverviewKpis>;
      return {
        active_buyers_count: Number(row.active_buyers_count || 0),
        registrations_count: Number(row.registrations_count || 0),
      } satisfies AnalyticsOverviewKpis;
    }),
    staleTime: 60_000,
    enabled: enabled && Boolean(viewerUserId),
  });
}

export function useAnalyticsRfmGroupBreakdown(
  viewerUserId: string | undefined,
  fromIso?: string | null,
  toIso?: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: ["analytics-rfm-group-breakdown", viewerUserId ?? "none", fromIso ?? "all", toIso ?? "all"],
    queryFn: async () => withQueryTiming("get_analytics_rfm_group_breakdown", { viewerUserId, fromIso: fromIso ?? null, toIso: toIso ?? null }, async () => {
      if (!viewerUserId) return [] as AnalyticsRfmGroupRow[];
      const { data, error } = await (supabase as any).rpc("get_analytics_rfm_group_breakdown", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      return ((data ?? []) as AnalyticsRfmGroupRow[]).map((row) => ({
        rfm_group: String(row.rfm_group || "Unclassified"),
        customers_count: Number(row.customers_count || 0),
        active_buyers_count: Number(row.active_buyers_count || 0),
        revenue: Number(row.revenue || 0),
      }));
    }),
    staleTime: 60_000,
    enabled: enabled && Boolean(viewerUserId),
  });
}

export function useAnalyticsRfmScoreMatrix(
  viewerUserId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ["analytics-rfm-score-matrix", viewerUserId ?? "none"],
    queryFn: async () => withQueryTiming("get_analytics_rfm_score_matrix", { viewerUserId }, async () => {
      if (!viewerUserId) return [] as AnalyticsRfmMatrixCell[];
      const { data, error } = await (supabase as any).rpc("get_analytics_rfm_score_matrix", {
        _viewer_user_id: viewerUserId,
      });
      if (error) throw error;
      return ((data ?? []) as AnalyticsRfmMatrixCell[]).map((row) => ({
        recency_score: Number(row.recency_score || 1),
        fm_score: Number(row.fm_score || 1),
        customers_count: Number(row.customers_count || 0),
      }));
    }),
    staleTime: 60_000,
    enabled: enabled && Boolean(viewerUserId),
  });
}

export function useSalespersonPerformance(
  scopeKey = "global",
  fromIso: string | null | undefined = null,
  toIso: string | null | undefined = null,
) {
  return useQuery({
    queryKey: ["salesperson-performance", scopeKey, fromIso ?? "none", toIso ?? "none"],
    queryFn: async () => withQueryTiming("useSalespersonPerformance", {
      scopeKey,
      fromIso: fromIso ?? null,
      toIso: toIso ?? null,
    }, async () => {
      const { data, error } = await supabase.rpc("get_salesperson_performance_rows", {
        _leader_user_id: null,
        _leader_role: null,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      return ((data ?? []) as SalespersonPerformanceRow[]).map((row) => ({
        ...row,
        customers_count: Number(row.customers_count || 0),
        orders_count: Number(row.orders_count || 0),
        revenue: Number(row.revenue || 0),
      }));
    }),
    staleTime: 60_000,
  });
}

export function useSalespersonFinancialBreakdown(
  scopeKey = "global",
  fromIso: string | null | undefined = null,
  toIso: string | null | undefined = null,
  leaderUserId: string | null | undefined = null,
  leaderRole: "manager" | "supervisor" | null = null,
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "salesperson-financial-breakdown",
      scopeKey,
      fromIso ?? "none",
      toIso ?? "none",
      leaderUserId ?? "none",
      leaderRole ?? "none",
    ],
    queryFn: async () => withQueryTiming("get_salesperson_financial_breakdown_rows", { scopeKey, fromIso: fromIso ?? null, toIso: toIso ?? null }, async () => {
      const { data, error } = await supabase.rpc("get_salesperson_financial_breakdown_rows", {
        _leader_user_id: leaderUserId ?? null,
        _leader_role: leaderRole ?? null,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      return ((data ?? []) as SalespersonFinancialBreakdownRow[]).map((row) => ({
        ...row,
        customers_count: Number(row.customers_count || 0),
        orders_total_count: Number(row.orders_total_count || 0),
        orders_paid_count: Number(row.orders_paid_count || 0),
        orders_pending_count: Number(row.orders_pending_count || 0),
        orders_refunded_count: Number(row.orders_refunded_count || 0),
        original_gross_sales: Number(row.original_gross_sales || 0),
        current_gross_sales: Number(row.current_gross_sales || 0),
        net_sales_ex_vat: Number(row.net_sales_ex_vat || 0),
        vat_collected: Number(row.vat_collected || 0),
        refunded_returned_value: Number(row.refunded_returned_value || 0),
        avg_order_original_gross: Number(row.avg_order_original_gross || 0),
        avg_order_current_gross: Number(row.avg_order_current_gross || 0),
        avg_order_net_ex_vat: Number(row.avg_order_net_ex_vat || 0),
      }));
    }),
    staleTime: 60_000,
    enabled,
  });
}

export function useDirectReportSalesPerformance(
  leaderUserId: string | undefined,
  leaderRole: "manager" | "supervisor",
  scopeKey = "global",
  fromIso: string | null | undefined = null,
  toIso: string | null | undefined = null,
) {
  return useQuery({
    queryKey: ["direct-report-sales-performance", leaderUserId ?? "none", leaderRole, scopeKey, fromIso ?? "none", toIso ?? "none"],
    queryFn: async () => withQueryTiming("useDirectReportSalesPerformance", {
      leaderUserId: leaderUserId ?? null,
      leaderRole,
      scopeKey,
      fromIso: fromIso ?? null,
      toIso: toIso ?? null,
    }, async () => {
      if (!leaderUserId) return [];
      const { data, error } = await supabase.rpc("get_salesperson_performance_rows", {
        _leader_user_id: leaderUserId,
        _leader_role: leaderRole,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      return ((data ?? []) as SalespersonPerformanceRow[]).map((row) => ({
        ...row,
        customers_count: Number(row.customers_count || 0),
        orders_count: Number(row.orders_count || 0),
        revenue: Number(row.revenue || 0),
      }));
    }),
    staleTime: 60_000,
    enabled: Boolean(leaderUserId),
  });
}

export function useSupervisorManagerScopePerformance(
  supervisorUserId: string | undefined,
  scopeKey = "global",
  fromIso: string | null | undefined = null,
  toIso: string | null | undefined = null,
) {
  return useQuery({
    queryKey: [
      "supervisor-manager-scope-performance",
      supervisorUserId ?? "none",
      scopeKey,
      fromIso ?? "none",
      toIso ?? "none",
    ],
    queryFn: async () => withQueryTiming("useSupervisorManagerScopePerformance", {
      supervisorUserId: supervisorUserId ?? null,
      scopeKey,
      fromIso: fromIso ?? null,
      toIso: toIso ?? null,
    }, async () => {
      if (!supervisorUserId) return [];
      const { data, error } = await supabase.rpc("get_supervisor_manager_scope_scorecards", {
        _supervisor_user_id: supervisorUserId,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      return (data ?? []) as (ViewerScopePerformanceRow & { manager_name: string })[];
    }),
    staleTime: 60_000,
    enabled: Boolean(supervisorUserId),
  });
}

export function useSupervisorManagerSelfPerformance(
  supervisorUserId: string | undefined,
  managerUserId: string | undefined,
  scopeKey = "global",
  fromIso: string | null | undefined = null,
  toIso: string | null | undefined = null,
) {
  return useQuery({
    queryKey: [
      "supervisor-manager-self-performance",
      supervisorUserId ?? "none",
      managerUserId ?? "none",
      scopeKey,
      fromIso ?? "none",
      toIso ?? "none",
    ],
    queryFn: async () =>
      withQueryTiming(
        "useSupervisorManagerSelfPerformance",
        {
          supervisorUserId: supervisorUserId ?? null,
          managerUserId: managerUserId ?? null,
          scopeKey,
          fromIso: fromIso ?? null,
          toIso: toIso ?? null,
        },
        async () => {
          if (!supervisorUserId || !managerUserId) return null as SupervisorManagerSelfPerformanceRow | null;
          const { data, error } = await (supabase as any).rpc("get_supervisor_manager_self_performance_row", {
            _supervisor_user_id: supervisorUserId,
            _manager_user_id: managerUserId,
            _from_iso: fromIso ?? null,
            _to_iso: toIso ?? null,
          });
          if (error) throw error;
          const row = (data?.[0] ?? null) as Partial<SupervisorManagerSelfPerformanceRow> | null;
          if (!row) return null;
          return {
            manager_user_id: String(row.manager_user_id ?? managerUserId),
            manager_name: String(row.manager_name ?? "Manager"),
            customers_count: Number(row.customers_count ?? 0),
            orders_count: Number(row.orders_count ?? 0),
            revenue: Number(row.revenue ?? 0),
          } satisfies SupervisorManagerSelfPerformanceRow;
        },
      ),
    staleTime: 60_000,
    enabled: Boolean(supervisorUserId) && Boolean(managerUserId),
  });
}

export function useManagerTeamMemberOptions(managerUserId: string | undefined, scopeKey = "global") {
  return useQuery({
    queryKey: ["manager-team-member-options", managerUserId ?? "none", scopeKey],
    queryFn: async () => withQueryTiming("useManagerTeamMemberOptions", {
      managerUserId: managerUserId ?? null,
      scopeKey,
    }, async () => {
      if (!managerUserId) return [] as TeamMemberOption[];
      const { data, error } = await (supabase as any).rpc("get_manager_team_member_options", {
        _manager_user_id: managerUserId,
      });
      if (error) throw error;
      return ((data ?? []) as { user_id?: string | null; display_name?: string | null }[])
        .map((row) => ({
          user_id: String(row.user_id ?? ""),
          label: String(row.display_name ?? "").trim() || "Salesperson",
        }))
        .filter((row) => row.user_id)
        .sort((a, b) => a.label.localeCompare(b.label));
    }),
    staleTime: 60_000,
    enabled: Boolean(managerUserId),
  });
}

export function useSupervisorManagerOptions(supervisorUserId: string | undefined, scopeKey = "global") {
  return useQuery({
    queryKey: ["supervisor-manager-options", supervisorUserId ?? "none", scopeKey],
    queryFn: async () => withQueryTiming("useSupervisorManagerOptions", {
      supervisorUserId: supervisorUserId ?? null,
      scopeKey,
    }, async () => {
      if (!supervisorUserId) return [] as TeamMemberOption[];
      const { data, error } = await (supabase as any).rpc("get_supervisor_manager_options", {
        _supervisor_user_id: supervisorUserId,
      });
      if (error) throw error;
      return ((data ?? []) as { user_id?: string | null; display_name?: string | null }[])
        .map((row) => ({
          user_id: String(row.user_id ?? ""),
          label: String(row.display_name ?? "").trim() || "Manager",
        }))
        .filter((row) => row.user_id);
    }),
    staleTime: 60_000,
    enabled: Boolean(supervisorUserId),
  });
}

export function useSupervisorSalespersonOptions(supervisorUserId: string | undefined, scopeKey = "global") {
  return useQuery({
    queryKey: ["supervisor-salesperson-options", supervisorUserId ?? "none", scopeKey],
    queryFn: async () => withQueryTiming("useSupervisorSalespersonOptions", {
      supervisorUserId: supervisorUserId ?? null,
      scopeKey,
    }, async () => {
      if (!supervisorUserId) return [] as TeamMemberOption[];
      const { data, error } = await (supabase as any).rpc("get_supervisor_salesperson_options", {
        _supervisor_user_id: supervisorUserId,
      });
      if (error) throw error;
      return ((data ?? []) as { user_id?: string | null; display_name?: string | null }[])
        .map((row) => ({
          user_id: String(row.user_id ?? ""),
          label: String(row.display_name ?? "").trim() || "Salesperson",
        }))
        .filter((row) => row.user_id);
    }),
    staleTime: 60_000,
    enabled: Boolean(supervisorUserId),
  });
}

export function useScopedUserOptions(
  viewerUserId: string | undefined,
  targetUserIds: string[],
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: ["scoped-user-options", scopeKey, viewerUserId ?? "none", [...targetUserIds].sort().join(",")],
    queryFn: async () => {
      if (!viewerUserId || !targetUserIds.length) return [] as TeamMemberOption[];
      const { data, error } = await (supabase as any).rpc("get_scoped_user_display_names", {
        _viewer_user_id: viewerUserId,
        _target_user_ids: targetUserIds,
      });
      if (error) throw error;
      return ((data ?? []) as { user_id?: string | null; display_name?: string | null }[])
        .map((row) => ({
          user_id: String(row.user_id ?? ""),
          label: String(row.display_name ?? "").trim() || "Salesperson",
        }))
        .filter((row) => row.user_id)
        .sort((a, b) => a.label.localeCompare(b.label));
    },
    staleTime: 60_000,
    enabled: enabled && Boolean(viewerUserId) && targetUserIds.length > 0,
  });
}

export function useCustomerIdsForSalespeople(
  salespersonUserIds: string[],
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: ["customer-ids-for-salespeople", scopeKey, [...salespersonUserIds].sort().join(",")],
    queryFn: async () => {
      if (!salespersonUserIds.length) return [] as string[];
      const viewerUserId = (await supabase.auth.getUser()).data.user?.id;
      if (!viewerUserId) return [] as string[];
      return fetchAllScopedCustomerIdsForViewer(viewerUserId, salespersonUserIds);
    },
    staleTime: 60_000,
    enabled: enabled && salespersonUserIds.length > 0,
  });
}

function splitIntoChunks<T>(values: T[], chunkSize: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) out.push(values.slice(i, i + chunkSize));
  return out;
}

function resolvePeriodIsoBounds(
  fromDate?: string,
  toDate?: string,
  fromIso?: string | null,
  toIso?: string | null,
): { fromIso: string | null; toIso: string | null } {
  if (fromIso !== undefined || toIso !== undefined) {
    return { fromIso: fromIso ?? null, toIso: toIso ?? null };
  }
  return {
    fromIso: toStoreDayStartIso(fromDate),
    toIso: toStoreDayEndExclusiveIso(toDate),
  };
}

function toStoreDayStartIso(ymd?: string | null): string | null {
  return storeDayStartIsoFromYmd(ymd);
}

/** Exclusive upper bound for a store-local calendar day (Asia/Dubai). */
function toStoreDayEndExclusiveIso(ymd?: string | null): string | null {
  return storeDayEndExclusiveIsoFromYmd(ymd);
}

async function fetchScopedMetricsAndSeriesBySalespeople(
  salespersonUserIds: string[],
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  bucket: TimeseriesBucket,
): Promise<ScopeOrderMetrics & { series: TimeseriesPoint[] }> {
  if (!salespersonUserIds.length) {
    return {
      orders_count: 0,
      customers_count: 0,
      revenue: 0,
      avg_order_value: 0,
      series: [],
    };
  }

  const viewerUserId = (await supabase.auth.getUser()).data.user?.id;
  if (!viewerUserId) {
    return {
      orders_count: 0,
      customers_count: 0,
      revenue: 0,
      avg_order_value: 0,
      series: [],
    };
  }
  const customerIds = await fetchAllScopedCustomerIdsForViewer(viewerUserId, salespersonUserIds);
  if (!customerIds.length) {
    return {
      orders_count: 0,
      customers_count: 0,
      revenue: 0,
      avg_order_value: 0,
      series: [],
    };
  }

  let customerRows: { id: string; shopify_customer_id: string | null; shopify_created_at: string | null; created_at: string | null }[] = [];
  for (const part of splitIntoChunks(customerIds, 200)) {
    const { data, error } = await supabase
      .from("shopify_customers")
      .select("id, shopify_customer_id, shopify_created_at, created_at")
      .in("id", part);
    if (error) throw error;
    customerRows = customerRows.concat(
      (data ?? []) as {
        id: string;
        shopify_customer_id: string | null;
        shopify_created_at: string | null;
        created_at: string | null;
      }[],
    );
  }

  const shopifyCustomerIds = Array.from(
    new Set(customerRows.map((r) => r.shopify_customer_id).filter((v): v is string => Boolean(v))),
  );

  const fromTs = fromIso ? new Date(fromIso).getTime() : null;
  const toTs = toIso ? new Date(toIso).getTime() : null;
  const isInRange = (iso: string) => {
    const ts = new Date(iso).getTime();
    if (Number.isNaN(ts)) return false;
    if (fromTs !== null && ts < fromTs) return false;
    if (toTs !== null && ts > toTs) return false;
    return true;
  };
  const customersCount = customerRows.reduce((count, row) => {
    const at = row.shopify_created_at || row.created_at;
    if (!at) return count;
    if (!isInRange(at)) return count;
    return count + 1;
  }, 0);

  const normalizeFinancialStatus = (status: string | null | undefined) => {
    const value = (status ?? "").trim().toLowerCase();
    if (value === "partially paid") return "partially_paid";
    if (value === "partially refunded") return "partially_refunded";
    return value || "pending";
  };
  const orderMap = new Map<
    string,
    { effOrig: number; effCurr: number; effTax: number; effRefund: number; at: string; status: string }
  >();
  const absorbOrders = (
    rows: {
      id: string;
      total: number | null;
      original_total: number | null;
      current_total: number | null;
      total_tax: number | null;
      financial_status: string | null;
      shopify_created_at: string | null;
      created_at: string | null;
    }[],
  ) => {
    for (const row of rows) {
      if (orderMap.has(row.id)) continue;
      const at = row.shopify_created_at || row.created_at;
      if (!at) continue;
      if (!isInRange(at)) continue;
      const status = normalizeFinancialStatus(row.financial_status);
      const voided = status === "voided";
      const origBase = Number(row.original_total ?? row.total ?? 0);
      const coalescedCurr =
        row.current_total != null ? Number(row.current_total) : origBase;
      const tax = Number(row.total_tax || 0);
      orderMap.set(row.id, {
        effOrig: voided ? 0 : origBase,
        effCurr: voided ? 0 : coalescedCurr,
        effTax: voided ? 0 : tax,
        effRefund: voided ? 0 : Math.max(0, origBase - coalescedCurr),
        at,
        status,
      });
    }
  };

  for (const part of splitIntoChunks(customerIds, 200)) {
    const query = supabase
      .from("shopify_orders")
      .select("id, total, original_total, current_total, total_tax, financial_status, shopify_created_at, created_at")
      .in("customer_id", part);
    const { data, error } = await query;
    if (error) throw error;
    absorbOrders(
      (data ?? []) as {
        id: string;
        total: number | null;
        original_total: number | null;
        current_total: number | null;
        total_tax: number | null;
        financial_status: string | null;
        shopify_created_at: string | null;
        created_at: string | null;
      }[],
    );
  }

  for (const part of splitIntoChunks(shopifyCustomerIds, 200)) {
    const query = supabase
      .from("shopify_orders")
      .select("id, total, original_total, current_total, total_tax, financial_status, shopify_created_at, created_at")
      .is("customer_id", null)
      .in("shopify_customer_id", part);
    const { data, error } = await query;
    if (error) throw error;
    absorbOrders(
      (data ?? []) as {
        id: string;
        total: number | null;
        original_total: number | null;
        current_total: number | null;
        total_tax: number | null;
        financial_status: string | null;
        shopify_created_at: string | null;
        created_at: string | null;
      }[],
    );
  }

  const seriesMap = new Map<string, TimeseriesPoint & { sortKey: string }>();
  let originalGrossSales = 0;
  let currentGrossSales = 0;
  let netSalesExVat = 0;
  let vatCollected = 0;
  let refundedReturnedValue = 0;
  let ordersCount = 0;
  let ordersPaidCount = 0;
  let ordersPendingCount = 0;
  let ordersRefundedCount = 0;

  for (const [, order] of orderMap) {
    originalGrossSales += order.effOrig;
    currentGrossSales += order.effCurr;
    netSalesExVat += order.effCurr - order.effTax;
    vatCollected += order.effTax;
    refundedReturnedValue += order.effRefund;
    ordersCount += 1;
    if (order.status === "paid" || order.status === "partially_paid") ordersPaidCount += 1;
    else if (order.status === "refunded" || order.status === "partially_refunded" || order.status === "voided") {
      ordersRefundedCount += 1;
    } else {
      ordersPendingCount += 1;
    }
    const { key, label } = storeTimeseriesBucket(order.at, bucket);
    const prev = seriesMap.get(key) || { label, revenue: 0, orders: 0, sortKey: key };
    prev.revenue += order.effCurr;
    prev.orders += 1;
    seriesMap.set(key, prev);
  }

  const series = Array.from(seriesMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => ({ label: v.label, revenue: v.revenue, orders: v.orders }));

  return {
    orders_count: ordersCount,
    customers_count: customersCount,
    revenue: currentGrossSales,
    avg_order_value: ordersCount > 0 ? currentGrossSales / ordersCount : 0,
    orders_total_count: ordersCount,
    orders_paid_count: ordersPaidCount,
    orders_pending_count: ordersPendingCount,
    orders_refunded_count: ordersRefundedCount,
    original_gross_sales: originalGrossSales,
    current_gross_sales: currentGrossSales,
    net_sales_ex_vat: netSalesExVat,
    vat_collected: vatCollected,
    refunded_returned_value: refundedReturnedValue,
    avg_order_original_gross: ordersCount > 0 ? originalGrossSales / ordersCount : 0,
    avg_order_current_gross: ordersCount > 0 ? currentGrossSales / ordersCount : 0,
    avg_order_net_ex_vat: ordersCount > 0 ? netSalesExVat / ordersCount : 0,
    orders_missing_current_total: 0,
    series,
  } satisfies SalespeopleScopedFinancialMetrics;
}

export function useSalespeopleScopedMetricsAndSeries(
  salespersonUserIds: string[],
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  bucket: TimeseriesBucket,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "salespeople-scoped-metrics-series",
      scopeKey,
      fromIso ?? "none",
      toIso ?? "none",
      bucket,
      [...salespersonUserIds].sort().join(","),
    ],
    queryFn: async () => {
      if (!salespersonUserIds.length) {
        return {
          orders_count: 0,
          customers_count: 0,
          revenue: 0,
          avg_order_value: 0,
          orders_total_count: 0,
          orders_paid_count: 0,
          orders_pending_count: 0,
          orders_refunded_count: 0,
          original_gross_sales: 0,
          current_gross_sales: 0,
          net_sales_ex_vat: 0,
          vat_collected: 0,
          refunded_returned_value: 0,
          avg_order_original_gross: 0,
          avg_order_current_gross: 0,
          avg_order_net_ex_vat: 0,
          orders_missing_current_total: 0,
          series: [] as TimeseriesPoint[],
        } satisfies SalespeopleScopedFinancialMetrics;
      }
      const viewerUserId = (await supabase.auth.getUser()).data.user?.id;
      if (!viewerUserId) {
        return {
          orders_count: 0,
          customers_count: 0,
          revenue: 0,
          avg_order_value: 0,
          orders_total_count: 0,
          orders_paid_count: 0,
          orders_pending_count: 0,
          orders_refunded_count: 0,
          original_gross_sales: 0,
          current_gross_sales: 0,
          net_sales_ex_vat: 0,
          vat_collected: 0,
          refunded_returned_value: 0,
          avg_order_original_gross: 0,
          avg_order_current_gross: 0,
          avg_order_net_ex_vat: 0,
          orders_missing_current_total: 0,
          series: [] as TimeseriesPoint[],
        } satisfies SalespeopleScopedFinancialMetrics;
      }
      const { data, error } = await (supabase as any).rpc("get_selected_salespeople_scope_metrics_timeseries", {
        _viewer_user_id: viewerUserId,
        _salesperson_user_ids: salespersonUserIds,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
        _bucket: bucket,
      });
      if (error) throw error;
      const row = (data?.[0] ?? {}) as {
        orders_count?: number;
        customers_count?: number;
        revenue?: number;
        avg_order_value?: number;
        orders_total_count?: number;
        orders_paid_count?: number;
        orders_pending_count?: number;
        orders_refunded_count?: number;
        original_gross_sales?: number;
        current_gross_sales?: number;
        net_sales_ex_vat?: number;
        vat_collected?: number;
        refunded_returned_value?: number;
        avg_order_original_gross?: number;
        avg_order_current_gross?: number;
        avg_order_net_ex_vat?: number;
        orders_missing_current_total?: number;
        series?: Array<{ label?: string; revenue?: number; orders?: number }> | string | null;
      };
      const parsedSeries = Array.isArray(row.series)
        ? row.series
        : typeof row.series === "string"
          ? (JSON.parse(row.series) as Array<{ label?: string; revenue?: number; orders?: number }>)
          : [];
      return {
        orders_count: Number(row.orders_count || 0),
        customers_count: Number(row.customers_count || 0),
        revenue: Number(row.revenue || 0),
        avg_order_value: Number(row.avg_order_value || 0),
        orders_total_count: Number(row.orders_total_count || 0),
        orders_paid_count: Number(row.orders_paid_count || 0),
        orders_pending_count: Number(row.orders_pending_count || 0),
        orders_refunded_count: Number(row.orders_refunded_count || 0),
        original_gross_sales: Number(row.original_gross_sales || 0),
        current_gross_sales: Number(row.current_gross_sales || 0),
        net_sales_ex_vat: Number(row.net_sales_ex_vat || 0),
        vat_collected: Number(row.vat_collected || 0),
        refunded_returned_value: Number(row.refunded_returned_value || 0),
        avg_order_original_gross: Number(row.avg_order_original_gross || 0),
        avg_order_current_gross: Number(row.avg_order_current_gross || 0),
        avg_order_net_ex_vat: Number(row.avg_order_net_ex_vat || 0),
        orders_missing_current_total: Number(row.orders_missing_current_total ?? 0),
        series: parsedSeries.map((item) => ({
          label: String(item.label ?? ""),
          revenue: Number(item.revenue || 0),
          orders: Number(item.orders || 0),
        })),
      } satisfies SalespeopleScopedFinancialMetrics;
    },
    staleTime: 60_000,
    enabled: enabled && salespersonUserIds.length > 0,
  });
}

export function useSalespeopleUnderManagers(
  managerUserIds: string[],
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: ["salespeople-under-managers", scopeKey, [...managerUserIds].sort().join(",")],
    queryFn: async () => {
      if (!managerUserIds.length) return [] as string[];
      /**
       * Use the get_pure_salespeople_under_managers RPC so that users who hold a
       * manager/supervisor role (e.g. the supervisor that owns the manager) are
       * filtered out even if they appear as members in sales_hierarchy_edges.
       * The admin-users edge function assigns BOTH a 'salesperson' and a leader
       * role to managers/supervisors, so the previous direct query against
       * sales_hierarchy_edges leaked leaders into the Salesperson dropdown.
       */
      const ids = new Set<string>();
      for (const part of splitIntoChunks(managerUserIds, 200)) {
        const { data, error } = await (supabase as any).rpc("get_pure_salespeople_under_managers", {
          _manager_user_ids: part,
        });
        if (error) throw error;
        for (const row of (data ?? []) as { user_id?: string | null }[]) {
          const id = String(row.user_id ?? "").trim();
          if (id) ids.add(id);
        }
      }
      return Array.from(ids);
    },
    staleTime: 60_000,
    enabled: enabled && managerUserIds.length > 0,
  });
}

export function useAggregateScopeMetricsForViewers(
  viewerUserIds: string[],
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "aggregate-scope-metrics-for-viewers",
      scopeKey,
      fromIso ?? "none",
      toIso ?? "none",
      [...viewerUserIds].sort().join(","),
    ],
    queryFn: async () => {
      if (!viewerUserIds.length) {
        return { orders_count: 0, customers_count: 0, revenue: 0, avg_order_value: 0 } satisfies ScopeOrderMetrics;
      }
      const { data, error } = await (supabase as any).rpc("get_scope_order_metrics_for_viewers", {
        _viewer_user_ids: viewerUserIds,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      const row = (data?.[0] ?? {}) as Partial<ScopeOrderMetrics>;
      const totals = {
        orders_count: Number(row.orders_count || 0),
        customers_count: Number(row.customers_count || 0),
        revenue: Number(row.revenue || 0),
      };
      return {
        ...totals,
        avg_order_value: totals.orders_count > 0 ? totals.revenue / totals.orders_count : 0,
      } satisfies ScopeOrderMetrics;
    },
    staleTime: 60_000,
    enabled: enabled && viewerUserIds.length > 0,
  });
}

export function useAggregateFinancialBreakdownForViewers(
  viewerUserIds: string[],
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "aggregate-financial-breakdown-for-viewers",
      scopeKey,
      fromIso ?? "none",
      toIso ?? "none",
      [...viewerUserIds].sort().join(","),
    ],
    queryFn: async () => {
      if (!viewerUserIds.length) {
        return {
          customers_count: 0,
          orders_total_count: 0,
          orders_paid_count: 0,
          orders_pending_count: 0,
          orders_refunded_count: 0,
          original_gross_sales: 0,
          current_gross_sales: 0,
          net_sales_ex_vat: 0,
          vat_collected: 0,
          refunded_returned_value: 0,
          avg_order_original_gross: 0,
          avg_order_current_gross: 0,
          avg_order_net_ex_vat: 0,
          orders_missing_current_total: 0,
        } satisfies ScopeFinancialBreakdown;
      }
      const { data, error } = await (supabase as any).rpc("get_scope_financial_breakdown_for_viewers", {
        _viewer_user_ids: viewerUserIds,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
      });
      if (error) throw error;
      const row = (data?.[0] ?? {}) as Partial<ScopeFinancialBreakdown>;
      return {
        customers_count: Number(row.customers_count || 0),
        orders_total_count: Number(row.orders_total_count || 0),
        orders_paid_count: Number(row.orders_paid_count || 0),
        orders_pending_count: Number(row.orders_pending_count || 0),
        orders_refunded_count: Number(row.orders_refunded_count || 0),
        original_gross_sales: Number(row.original_gross_sales || 0),
        current_gross_sales: Number(row.current_gross_sales || 0),
        net_sales_ex_vat: Number(row.net_sales_ex_vat || 0),
        vat_collected: Number(row.vat_collected || 0),
        refunded_returned_value: Number(row.refunded_returned_value || 0),
        avg_order_original_gross: Number(row.avg_order_original_gross || 0),
        avg_order_current_gross: Number(row.avg_order_current_gross || 0),
        avg_order_net_ex_vat: Number(row.avg_order_net_ex_vat || 0),
        orders_missing_current_total: Number(row.orders_missing_current_total ?? 0),
      } satisfies ScopeFinancialBreakdown;
    },
    staleTime: 60_000,
    enabled: enabled && viewerUserIds.length > 0,
  });
}

export function useSupervisorSelectedManagerTimeseries(
  supervisorUserId: string | undefined,
  managerUserIds: string[],
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  bucket: TimeseriesBucket,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "supervisor-selected-manager-timeseries",
      scopeKey,
      supervisorUserId ?? "none",
      fromIso ?? "none",
      toIso ?? "none",
      bucket,
      [...managerUserIds].sort().join(","),
    ],
    queryFn: async () => withQueryTiming("useSupervisorSelectedManagerTimeseries", {
      supervisorUserId,
      managerCount: managerUserIds.length,
      fromIso: fromIso ?? null,
      toIso: toIso ?? null,
      bucket,
      scopeKey,
    }, async () => {
      if (!supervisorUserId || !managerUserIds.length) return [] as TimeseriesPoint[];
      const { data, error } = await (supabase as any).rpc("get_supervisor_selected_manager_timeseries", {
        _supervisor_user_id: supervisorUserId,
        _manager_user_ids: managerUserIds,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
        _bucket: bucket,
      });
      if (error) throw error;
      return ((data ?? []) as { bucket_label?: string; revenue?: number; orders_count?: number }[]).map((row) => ({
        label: String(row.bucket_label ?? ""),
        revenue: Number(row.revenue || 0),
        orders: Number(row.orders_count || 0),
      }));
    }),
    staleTime: 60_000,
    enabled: enabled && Boolean(supervisorUserId) && managerUserIds.length > 0,
  });
}

export function useManagerSelectedSalespeopleTimeseries(
  managerUserId: string | undefined,
  salespersonUserIds: string[],
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  bucket: TimeseriesBucket,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "manager-selected-salespeople-timeseries",
      scopeKey,
      managerUserId ?? "none",
      fromIso ?? "none",
      toIso ?? "none",
      bucket,
      [...salespersonUserIds].sort().join(","),
    ],
    queryFn: async () => withQueryTiming("useManagerSelectedSalespeopleTimeseries", {
      managerUserId,
      salespersonCount: salespersonUserIds.length,
      fromIso: fromIso ?? null,
      toIso: toIso ?? null,
      bucket,
      scopeKey,
    }, async () => {
      if (!managerUserId || !salespersonUserIds.length) return [] as TimeseriesPoint[];
      const { data, error } = await (supabase as any).rpc("get_manager_selected_salespeople_timeseries", {
        _manager_user_id: managerUserId,
        _salesperson_user_ids: salespersonUserIds,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
        _bucket: bucket,
      });
      if (error) throw error;
      return ((data ?? []) as { bucket_label?: string; revenue?: number; orders_count?: number }[]).map((row) => ({
        label: String(row.bucket_label ?? ""),
        revenue: Number(row.revenue || 0),
        orders: Number(row.orders_count || 0),
      }));
    }),
    staleTime: 60_000,
    enabled: enabled && Boolean(managerUserId) && salespersonUserIds.length > 0,
  });
}

type CustomerQueryParams = {
  page: number;
  pageSize: number;
  search?: string;
  cityFilter?: string;
  assignmentFilter?: "all" | "assigned" | "unassigned";
  rfmGroupFilter?: string;
  fromDate?: string;
  toDate?: string;
  fromIso?: string | null;
  toIso?: string | null;
  sortBy?: "total_revenue" | "total_orders" | "shopify_created_at" | "name";
  sortDir?: "asc" | "desc";
  scopeSalespersonIds?: string[];
  scopeCustomerIds?: string[];
  scopeOwnerNames?: string[];
  forceScopedFilter?: boolean;
  enabled?: boolean;
};

export function useCustomers() {
  return useQuery({
    queryKey: ["shopify-customers-legacy"],
    queryFn: async () => {
      const pageSize = 1000;
      let from = 0;
      let rows: any[] = [];
      while (true) {
        const to = from + pageSize - 1;
        const { data, error } = await supabase
          .from("shopify_customers")
          .select("*")
          .order("total_revenue", { ascending: false })
          .range(from, to);
        if (error) throw error;
        const batch = data ?? [];
        rows = rows.concat(batch);
        if (batch.length < pageSize) break;
        from += pageSize;
      }
      return rows;
    },
  });
}

export function useCustomersPaginated(params: CustomerQueryParams) {
  const {
    page,
    pageSize,
    search = "",
    cityFilter = "all",
    assignmentFilter = "all",
    rfmGroupFilter = "all",
    fromDate,
    toDate,
    fromIso: fromIsoParam,
    toIso: toIsoParam,
    sortBy = "total_revenue",
    sortDir = "desc",
    scopeSalespersonIds = [],
    scopeCustomerIds = [],
    scopeOwnerNames = [],
    forceScopedFilter = false,
    enabled = true,
  } = params;
  const { fromIso, toIso } = resolvePeriodIsoBounds(fromDate, toDate, fromIsoParam, toIsoParam);
  const salespersonScopeKey = [...scopeSalespersonIds].sort().join(",");
  const scopeKey = [...scopeCustomerIds].sort().join(",");
  const ownerScopeKey = [...scopeOwnerNames].map((name) => name.trim()).filter(Boolean).sort().join(",");
  return useQuery({
    queryKey: [
      "shopify-customers",
      page,
      pageSize,
      search,
      cityFilter,
      assignmentFilter,
      rfmGroupFilter,
      fromDate,
      toDate,
      fromIsoParam,
      toIsoParam,
      sortBy,
      sortDir,
      salespersonScopeKey,
      scopeKey,
      ownerScopeKey,
    ],
    queryFn: async () => {
      const scopedCustomerIdsFinal = Array.from(new Set(scopeCustomerIds.filter(Boolean)));
      const scopedSalespeopleFinal = Array.from(new Set(scopeSalespersonIds.filter(Boolean)));
      const scopedOwnerNamesFinal = Array.from(new Set(scopeOwnerNames.map((name) => name.trim()).filter(Boolean)));
      const requestedScopedFilter =
        forceScopedFilter ||
        (params.scopeSalespersonIds?.length ?? 0) > 0 ||
        (params.scopeCustomerIds?.length ?? 0) > 0 ||
        (params.scopeOwnerNames?.length ?? 0) > 0;
      if (requestedScopedFilter || scopedCustomerIdsFinal.length > 0) {
        if (
          scopedCustomerIdsFinal.length === 0 &&
          scopedSalespeopleFinal.length === 0 &&
          scopedOwnerNamesFinal.length === 0
        ) {
          return { data: [], count: 0 };
        }
        const viewerUserId = (await supabase.auth.getUser()).data.user?.id;
        if (!viewerUserId) return { data: [], count: 0 };
        const { data: scopedRows, error: scopedError } = await (supabase as any).rpc("get_scoped_customers_page", {
          _viewer_user_id: viewerUserId,
          _salesperson_user_ids: scopedSalespeopleFinal,
          _owner_names: scopedOwnerNamesFinal,
          _search: search || null,
          _city_filter: cityFilter,
          _assignment_filter: assignmentFilter,
          _rfm_group_filter: rfmGroupFilter,
          _from_iso: fromIso,
          _to_iso: toIso,
          _sort_by: sortBy,
          _sort_dir: sortDir,
          _page: page,
          _page_size: pageSize,
          _force_scoped_filter: true,
          _customer_ids: scopedCustomerIdsFinal,
        });
        if (scopedError) throw scopedError;
        const rows = (scopedRows ?? []) as { row_data: any; total_count: number | null }[];
        return {
          data: rows.map((r) => r.row_data).filter(Boolean),
          count: Number(rows[0]?.total_count ?? 0),
        };
      }
      let query = supabase
        .from("shopify_customers")
        .select("*", { count: "exact" })
        .order(sortBy, { ascending: sortDir === "asc" });

      const q = search.trim();
      if (q) {
        const escaped = q.replace(/[%_]/g, "");
        query = query.or(`name.ilike.%${escaped}%,city.ilike.%${escaped}%,email.ilike.%${escaped}%`);
      }
      if (cityFilter !== "all") query = query.eq("city", cityFilter);
      if (fromIso) query = query.gte("shopify_created_at", fromIso);
      if (toIso) query = query.lt("shopify_created_at", toIso);
      if (rfmGroupFilter !== "all") query = query.eq("rfm_group", rfmGroupFilter);
      if (assignmentFilter === "assigned") {
        query = query.not("sp_assigned", "is", null).neq("sp_assigned", "Unassigned");
      } else if (assignmentFilter === "unassigned") {
        query = query.or("sp_assigned.is.null,sp_assigned.eq.Unassigned");
      }
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) {
        devError("useCustomersPaginated failed", {
          message: error.message,
          details: (error as { details?: string }).details,
          hint: (error as { hint?: string }).hint,
          code: (error as { code?: string }).code,
          params: {
            page,
            pageSize,
            search,
            cityFilter,
            assignmentFilter,
            rfmGroupFilter,
            fromDate,
            toDate,
            sortBy,
            sortDir,
            scopeCustomerIdsCount: scopeCustomerIds.length,
          },
        });
        throw error;
      }
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    enabled,
  });
}

export function useCustomerCities() {
  return useQuery({
    queryKey: ["shopify-customer-cities"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shopify_customers")
        .select("city")
        .not("city", "is", null)
        .limit(5000);
      if (error) throw error;
      const uniq = Array.from(new Set((data ?? []).map((r) => r.city).filter(Boolean))).sort();
      return ["all", ...uniq] as string[];
    },
    staleTime: 60_000,
  });
}

export function useOrders() {
  return useQuery({
    queryKey: ["shopify-orders-legacy"],
    queryFn: async () => {
      const pageSize = 1000;
      let from = 0;
      let rows: any[] = [];
      while (true) {
        const to = from + pageSize - 1;
        const { data, error } = await supabase
          .from("shopify_orders")
          .select("*")
          .order("shopify_created_at", { ascending: false })
          .range(from, to);
        if (error) throw error;
        const batch = data ?? [];
        rows = rows.concat(batch);
        if (batch.length < pageSize) break;
        from += pageSize;
      }
      return rows;
    },
  });
}

export function useOrdersCount(scopeKey = "global") {
  return useQuery({
    queryKey: ["shopify-orders-count", scopeKey],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("shopify_orders")
        .select("id", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
  });
}

export function useCustomersCount(scopeKey = "global") {
  return useQuery({
    queryKey: ["shopify-customers-count", scopeKey],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("shopify_customers")
        .select("id", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
  });
}

export function useTopCustomers(limit = 3, scopeKey = "global") {
  return useQuery({
    queryKey: ["shopify-top-customers", limit, scopeKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shopify_customers")
        .select("id, name, total_orders, total_revenue")
        .order("total_revenue", { ascending: false, nullsFirst: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 30_000,
  });
}

export function useUnfulfilledOrdersCount() {
  return useQuery({
    queryKey: ["shopify-unfulfilled-orders-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("shopify_orders")
        .select("id", { count: "exact", head: true })
        .in("fulfillment_status", ["unfulfilled", "partial", "on_hold"]);
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
  });
}

export function useUnfulfilledOrdersCountInRange(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: ["shopify-unfulfilled-orders-count-range", fromIso ?? "none", toIso ?? "none", scopeKey],
    queryFn: async () => {
      let q = supabase
        .from("shopify_orders")
        .select("id", { count: "exact", head: true })
        .in("fulfillment_status", ["unfulfilled", "partial", "on_hold"]);
      if (fromIso) q = q.gte("shopify_created_at", fromIso);
      if (toIso) q = q.lt("shopify_created_at", toIso);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
    enabled: enabled && Boolean(fromIso && toIso),
  });
}

export function useRecentOrders(limit = 10, scopeKey = "global") {
  return useQuery({
    queryKey: ["shopify-recent-orders", limit, scopeKey],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shopify_orders")
        .select(
          "id, order_number, shopify_order_id, customer_name, total, currency_code, financial_status, fulfillment_status, shopify_created_at, created_at",
        )
        .order("shopify_created_at", { ascending: false, nullsFirst: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 30_000,
  });
}

export function useRevenueByMonthForYear(year?: number, scopeKey = "global") {
  const activeYear = year ?? new Date().getUTCFullYear();
  return useQuery({
    queryKey: ["shopify-revenue-by-month", activeYear, scopeKey],
    queryFn: async () => {
      const pageSize = 1000;
      let offset = 0;
      const rows: { shopify_created_at: string | null; created_at: string | null; total: number | null }[] = [];
      while (true) {
        const to = offset + pageSize - 1;
        const { data, error } = await supabase
          .from("shopify_orders")
          .select("shopify_created_at, created_at, total")
          .range(offset, to);
        if (error) throw error;
        const batch = data ?? [];
        rows.push(...(batch as typeof rows));
        if (batch.length < pageSize) break;
        offset += pageSize;
      }

      const months = Array.from({ length: 12 }, (_, i) => ({
        monthIdx: i,
        month: new Date(Date.UTC(2020, i, 1)).toLocaleString("en", {
          month: "short",
          timeZone: SHOPIFY_REPORTING_TIMEZONE,
        }),
        revenue: 0,
        orders: 0,
        year: activeYear,
      }));

      for (const row of rows) {
        const d = row.shopify_created_at || row.created_at;
        if (!d) continue;
        const parsed = new Date(d);
        if (Number.isNaN(parsed.getTime())) continue;
        const { key } = storeTimeseriesBucket(d, "month");
        const [yearStr, monthStr] = key.split("-");
        const year = Number(yearStr);
        const idx = Number(monthStr) - 1;
        if (year !== activeYear || idx < 0 || idx > 11) continue;
        months[idx].revenue += Number(row.total || 0);
        months[idx].orders += 1;
      }
      return months;
    },
    staleTime: 60_000,
  });
}

export function useOrdersTotalRevenue(scopeKey = "global") {
  return useQuery({
    queryKey: ["shopify-orders-total-revenue", scopeKey],
    queryFn: async () => {
      const pageSize = 1000;
      let from = 0;
      let total = 0;
      while (true) {
        const to = from + pageSize - 1;
        const { data, error } = await supabase
          .from("shopify_orders")
          .select("total, original_total, current_total")
          .range(from, to);
        if (error) throw error;
        const batch = data ?? [];
        for (const row of batch) {
          const r = row as { total?: number | null; original_total?: number | null; current_total?: number | null };
          const orig = Number(r.original_total ?? r.total ?? 0);
          const curr = r.current_total != null ? Number(r.current_total) : orig;
          total += curr;
        }
        if (batch.length < pageSize) break;
        from += pageSize;
      }
      return total;
    },
    staleTime: 60_000,
  });
}

async function paginateOrderTotalsFiltered(
  fromIso?: string | null,
  toIso?: string | null,
): Promise<{ revenue: number; count: number }> {
  const pageSize = 1000;
  let offset = 0;
  let revenue = 0;
  let count = 0;
  while (true) {
    let q = supabase.from("shopify_orders").select("total, original_total, current_total");
    if (fromIso) q = q.gte("shopify_created_at", fromIso);
    if (toIso) q = q.lt("shopify_created_at", toIso);
    const to = offset + pageSize - 1;
    const { data, error } = await q.range(offset, to);
    if (error) throw error;
    const batch = data ?? [];
    count += batch.length;
    for (const row of batch) {
      const r = row as { total?: number | null; original_total?: number | null; current_total?: number | null };
      const orig = Number(r.original_total ?? r.total ?? 0);
      const curr = r.current_total != null ? Number(r.current_total) : orig;
      revenue += curr;
    }
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return { revenue, count };
}

export function useOrdersMetricsInRange(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: ["shopify-orders-metrics-range", fromIso ?? "none", toIso ?? "none", scopeKey],
    queryFn: () => paginateOrderTotalsFiltered(fromIso || undefined, toIso || undefined),
    staleTime: 60_000,
    enabled: enabled && Boolean(fromIso && toIso),
  });
}

export function useCustomersCountInRange(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: ["shopify-customers-count-range", fromIso ?? "none", toIso ?? "none", scopeKey],
    queryFn: async () => {
      let q = supabase.from("shopify_customers").select("id", { count: "exact", head: true });
      if (fromIso) q = q.gte("shopify_created_at", fromIso);
      if (toIso) q = q.lt("shopify_created_at", toIso);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 60_000,
    enabled: enabled && Boolean(fromIso && toIso),
  });
}

export type TimeseriesBucket = "day" | "month";

export function useOrdersTimeseriesInRange(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  bucket: TimeseriesBucket,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: ["shopify-orders-timeseries", fromIso ?? "none", toIso ?? "none", bucket, scopeKey],
    queryFn: async () => {
      const pageSize = 1000;
      let offset = 0;
      const rows: {
        shopify_created_at: string | null;
        created_at: string | null;
        total: number | null;
        original_total: number | null;
        current_total: number | null;
      }[] = [];
      while (true) {
        let q = supabase
          .from("shopify_orders")
          .select("shopify_created_at, created_at, total, original_total, current_total");
        if (fromIso) q = q.gte("shopify_created_at", fromIso);
        if (toIso) q = q.lt("shopify_created_at", toIso);
        const to = offset + pageSize - 1;
        const { data, error } = await q.range(offset, to);
        if (error) throw error;
        const batch = data ?? [];
        rows.push(...(batch as typeof rows));
        if (batch.length < pageSize) break;
        offset += pageSize;
      }
      const map = new Map<string, { revenue: number; orders: number; label: string; sortKey: string }>();
      for (const row of rows) {
        const d = row.shopify_created_at || row.created_at;
        if (!d) continue;
        const { key, label } = storeTimeseriesBucket(d, bucket);
        const prev = map.get(key) || { revenue: 0, orders: 0, label, sortKey: key };
        const orig = Number(row.original_total ?? row.total ?? 0);
        const curr = row.current_total != null ? Number(row.current_total) : orig;
        prev.revenue += curr;
        prev.orders += 1;
        map.set(key, prev);
      }
      return Array.from(map.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, v]) => ({ label: v.label, revenue: v.revenue, orders: v.orders }));
    },
    staleTime: 60_000,
    enabled: enabled && Boolean(fromIso && toIso),
  });
}

export function useScopeOrderTimeseries(
  viewerUserId: string | undefined,
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  bucket: TimeseriesBucket,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "scope-order-timeseries",
      viewerUserId ?? "none",
      fromIso ?? "none",
      toIso ?? "none",
      bucket,
      scopeKey,
    ],
    queryFn: async () => withQueryTiming("useScopeOrderTimeseries", {
      viewerUserId,
      fromIso: fromIso ?? null,
      toIso: toIso ?? null,
      bucket,
      scopeKey,
    }, async () => {
      if (!viewerUserId) return [] as TimeseriesPoint[];
      const { data, error } = await (supabase as any).rpc("get_scope_order_timeseries", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso ?? null,
        _to_iso: toIso ?? null,
        _bucket: bucket,
      });
      if (error) {
        devError("useScopeOrderTimeseries failed", {
          message: error.message,
          details: (error as { details?: string }).details,
          hint: (error as { hint?: string }).hint,
          code: (error as { code?: string }).code,
          params: {
            viewerUserId,
            fromIso: fromIso ?? null,
            toIso: toIso ?? null,
            bucket,
          },
        });
        throw error;
      }
      return ((data ?? []) as { bucket_label?: string; revenue?: number; orders_count?: number }[]).map((row) => ({
        label: String(row.bucket_label ?? ""),
        revenue: Number(row.revenue || 0),
        orders: Number(row.orders_count || 0),
      }));
    }),
    staleTime: 10_000,
    refetchInterval: fromIso && toIso ? 20_000 : false,
    refetchOnWindowFocus: true,
    enabled: enabled && Boolean(viewerUserId),
  });
}

export function useRecentOrdersInRange(
  limit: number,
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
  scopeKey = "global",
  enabled = true,
) {
  return useQuery({
    queryKey: ["shopify-recent-orders-range", limit, fromIso ?? "none", toIso ?? "none", scopeKey],
    queryFn: async () => {
      let q = supabase
        .from("shopify_orders")
        .select(
          "id, order_number, shopify_order_id, customer_name, total, currency_code, financial_status, fulfillment_status, shopify_created_at, created_at",
        )
        .order("shopify_created_at", { ascending: false, nullsFirst: false })
        .limit(limit);
      if (fromIso) q = q.gte("shopify_created_at", fromIso);
      if (toIso) q = q.lt("shopify_created_at", toIso);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 30_000,
    enabled: enabled && Boolean(fromIso && toIso),
  });
}

type OrdersQueryParams = {
  page: number;
  pageSize: number;
  search?: string;
  statusFilter?: string;
  fulfillmentFilter?: string;
  fromDate?: string;
  toDate?: string;
  fromIso?: string | null;
  toIso?: string | null;
  sortBy?: "shopify_created_at" | "processed_at" | "total" | "order_number";
  sortDir?: "asc" | "desc";
  scopeSalespersonIds?: string[];
  scopeCustomerIds?: string[];
  scopeOwnerNames?: string[];
  forceScopedFilter?: boolean;
  enabled?: boolean;
};

export function useOrdersPaginated(params: OrdersQueryParams) {
  const {
    page,
    pageSize,
    search = "",
    statusFilter = "all",
    fulfillmentFilter = "all",
    fromDate,
    toDate,
    fromIso: fromIsoParam,
    toIso: toIsoParam,
    sortBy = "shopify_created_at",
    sortDir = "desc",
    scopeSalespersonIds = [],
    scopeCustomerIds = [],
    scopeOwnerNames = [],
    forceScopedFilter = false,
    enabled = true,
  } = params;
  const { fromIso, toIso } = resolvePeriodIsoBounds(fromDate, toDate, fromIsoParam, toIsoParam);
  const salespersonScopeKey = [...scopeSalespersonIds].sort().join(",");
  const scopeKey = [...scopeCustomerIds].sort().join(",");
  const ownerScopeKey = [...scopeOwnerNames].map((name) => name.trim()).filter(Boolean).sort().join(",");
  return useQuery({
    queryKey: [
      "shopify-orders",
      page,
      pageSize,
      search,
      statusFilter,
      fulfillmentFilter,
      fromDate,
      toDate,
      fromIsoParam,
      toIsoParam,
      sortBy,
      sortDir,
      salespersonScopeKey,
      scopeKey,
      ownerScopeKey,
    ],
    queryFn: async () => {
      const scopedCustomerIdsFinal = Array.from(new Set(scopeCustomerIds.filter(Boolean)));
      const scopedSalespeopleFinal = Array.from(new Set(scopeSalespersonIds.filter(Boolean)));
      const scopedOwnerNamesFinal = Array.from(new Set(scopeOwnerNames.map((name) => name.trim()).filter(Boolean)));
      let query = supabase
        .from("shopify_orders")
        .select("*", { count: "exact" })
        .order(sortBy, { ascending: sortDir === "asc", nullsFirst: false });
      const q = search.trim();
      if (q) {
        const escaped = q.replace(/[%_]/g, "");
        query = query.or(`order_number.ilike.%${escaped}%,customer_name.ilike.%${escaped}%`);
      }
      if (statusFilter !== "all") query = query.eq("financial_status", statusFilter);
      if (fulfillmentFilter !== "all") query = query.eq("fulfillment_status", fulfillmentFilter);
      if (fromIso) query = query.gte("shopify_created_at", fromIso);
      if (toIso) query = query.lt("shopify_created_at", toIso);
      const requestedScopedFilter =
        forceScopedFilter ||
        (params.scopeSalespersonIds?.length ?? 0) > 0 ||
        (params.scopeCustomerIds?.length ?? 0) > 0 ||
        (params.scopeOwnerNames?.length ?? 0) > 0;
      if (requestedScopedFilter || scopedCustomerIdsFinal.length > 0) {
        const viewerUserId = (await supabase.auth.getUser()).data.user?.id;
        if (!viewerUserId) return { data: [], count: 0 };
        if (
          scopedCustomerIdsFinal.length === 0 &&
          scopedSalespeopleFinal.length === 0 &&
          scopedOwnerNamesFinal.length === 0
        ) {
          return { data: [], count: 0 };
        }
        const { data: scopedRows, error: scopedError } = await (supabase as any).rpc("get_scoped_orders_page", {
          _viewer_user_id: viewerUserId,
          _salesperson_user_ids: scopedSalespeopleFinal,
          _owner_names: scopedOwnerNamesFinal,
          _search: search || null,
          _status_filter: statusFilter,
          _fulfillment_filter: fulfillmentFilter,
          _from_iso: fromIso,
          _to_iso: toIso,
          _sort_by: sortBy,
          _sort_dir: sortDir,
          _page: page,
          _page_size: pageSize,
          _force_scoped_filter: true,
          _customer_ids: scopedCustomerIdsFinal,
          _filter_by_reporting_day: false,
        });
        if (scopedError) {
          devError("useOrdersPaginated scoped RPC failed", {
            message: scopedError.message,
            details: (scopedError as { details?: string }).details,
            hint: (scopedError as { hint?: string }).hint,
            code: (scopedError as { code?: string }).code,
            viewerUserId,
            scopedSalespeopleFinal,
            scopedOwnerNamesFinal,
            fromIso,
            toIso,
          });
          throw scopedError;
        }
        const rows = (scopedRows ?? []) as { row_data: any; total_count: number | null }[];
        return {
          data: rows.map((r) => r.row_data).filter(Boolean),
          count: Number(rows[0]?.total_count ?? 0),
        };
      }
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) {
        devError("useOrdersPaginated failed", {
          message: error.message,
          details: (error as { details?: string }).details,
          hint: (error as { hint?: string }).hint,
          code: (error as { code?: string }).code,
          params: {
            page,
            pageSize,
            search,
            statusFilter,
            fulfillmentFilter,
            fromDate,
            toDate,
            sortBy,
            sortDir,
            scopeCustomerIdsCount: scopeCustomerIds.length,
          },
        });
        throw error;
      }
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    enabled,
  });
}

export function useOrderItems(orderId?: string) {
  return useQuery({
    queryKey: ["shopify-order-items", orderId],
    queryFn: async () => {
      if (!orderId) return [];
      const { data: userData } = await supabase.auth.getUser();
      const viewerUserId = userData.user?.id;
      if (!viewerUserId) return [];
      const { data, error } = await supabase.rpc("get_shopify_order_items_for_viewer", {
        _viewer_user_id: viewerUserId,
        _order_id: orderId,
      });
      if (error) throw error;
      return (data ?? []) as Tables<"shopify_order_items">[];
    },
    enabled: !!orderId,
  });
}

export function useOrderFulfillments(orderId?: string) {
  return useQuery({
    queryKey: ["shopify-order-fulfillments", orderId],
    queryFn: async () => {
      if (!orderId) return [] as OrderFulfillment[];
      const { data, error } = await supabase
        .from("shopify_order_fulfillments")
        .select(
          "id, order_id, shopify_fulfillment_id, shipment_status, tracking_company, tracking_number, tracking_url, fulfilled_at, created_at, updated_at",
        )
        .eq("order_id", orderId)
        .order("fulfilled_at", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as OrderFulfillment[];
    },
    enabled: !!orderId,
    staleTime: 30_000,
  });
}

export function useOrderById(orderId?: string) {
  return useQuery({
    queryKey: ["shopify-order-by-id", orderId ?? "none"],
    queryFn: async () => {
      if (!orderId) return null;
      const { data, error } = await supabase
        .from("shopify_orders")
        .select("*")
        .eq("id", orderId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: Boolean(orderId),
    staleTime: 60_000,
  });
}

export function useCustomerRecentOrders(
  customerId?: string,
  shopifyCustomerId?: string,
  limit = 12,
  enabled = true,
) {
  return useQuery({
    queryKey: ["customer-recent-orders", customerId ?? "none", shopifyCustomerId ?? "none", limit],
    queryFn: async () => {
      if (!customerId && !shopifyCustomerId) return [] as RecentCustomerOrder[];
      let query = supabase
        .from("shopify_orders")
        .select(
          "id, order_number, shopify_order_id, customer_id, shopify_customer_id, customer_name, email, total, subtotal, total_tax, currency_code, financial_status, fulfillment_status, processed_at, shopify_created_at, created_at, tags, order_note",
        )
        .order("shopify_created_at", { ascending: false, nullsFirst: false })
        .limit(limit);
      if (customerId && shopifyCustomerId) {
        query = query.or(`customer_id.eq.${customerId},shopify_customer_id.eq.${shopifyCustomerId}`);
      } else if (customerId) {
        query = query.eq("customer_id", customerId);
      } else if (shopifyCustomerId) {
        query = query.eq("shopify_customer_id", shopifyCustomerId);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as RecentCustomerOrder[];
    },
    enabled: enabled && Boolean(customerId || shopifyCustomerId),
    staleTime: 60_000,
  });
}

export function useProducts() {
  return useQuery({
    queryKey: ["shopify-products-legacy"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shopify_products")
        .select("*, shopify_variants(*)")
        .order("title");
      if (error) throw error;
      return data;
    },
  });
}

type ProductsQueryParams = {
  page: number;
  pageSize: number;
  search?: string;
  statusFilter?: string;
  fromDate?: string;
  toDate?: string;
  sortBy?: "title" | "updated_at" | "created_at" | "vendor";
  sortDir?: "asc" | "desc";
};

export function useProductsPaginated(params: ProductsQueryParams) {
  const {
    page,
    pageSize,
    search = "",
    statusFilter = "all",
    fromDate,
    toDate,
    sortBy = "title",
    sortDir = "asc",
  } = params;
  const fromIso = toStoreDayStartIso(fromDate);
  const toIso = toStoreDayEndExclusiveIso(toDate);
  return useQuery({
    queryKey: ["shopify-products", page, pageSize, search, statusFilter, fromDate, toDate, sortBy, sortDir],
    queryFn: async () => {
      let query = supabase
        .from("shopify_products")
        .select(
          "id, title, vendor, category, status, handle, tags, featured_image_url, created_at, updated_at",
          { count: "exact" },
        )
        .order(sortBy, { ascending: sortDir === "asc" });
      const q = search.trim();
      if (q) {
        const escaped = q.replace(/[%_]/g, "");
        query = query.or(`title.ilike.%${escaped}%,vendor.ilike.%${escaped}%,category.ilike.%${escaped}%`);
      }
      if (statusFilter !== "all") query = query.eq("status", statusFilter);
      if (fromIso) query = query.gte("updated_at", fromIso);
      if (toIso) query = query.lt("updated_at", toIso);
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useProductVariantsByProductIds(productIds: string[], enabled = true) {
  const dedupedIds = Array.from(new Set(productIds.filter(Boolean)));
  return useQuery({
    queryKey: ["shopify-product-variants-by-product-ids", dedupedIds.sort().join(",")],
    queryFn: async () => {
      if (!dedupedIds.length) return [] as {
        id: string;
        product_id: string;
        title: string | null;
        sku: string | null;
        price: number | null;
        stock: number | null;
        inventory_location: string | null;
      }[];
      const { data, error } = await supabase
        .from("shopify_variants")
        .select("id, product_id, title, sku, price, stock, inventory_location")
        .in("product_id", dedupedIds);
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        product_id: string;
        title: string | null;
        sku: string | null;
        price: number | null;
        stock: number | null;
        inventory_location: string | null;
      }[];
    },
    staleTime: 60_000,
    enabled: enabled && dedupedIds.length > 0,
  });
}

export function useProductStatuses() {
  return useQuery({
    queryKey: ["shopify-product-statuses"],
    queryFn: async () => {
      const { data, error } = await supabase.from("shopify_products").select("status").limit(5000);
      if (error) throw error;
      const uniq = Array.from(new Set((data ?? []).map((r) => r.status).filter(Boolean))).sort();
      return ["all", ...uniq] as string[];
    },
    staleTime: 60_000,
  });
}

export function useVariants() {
  return useQuery({
    queryKey: ["shopify-variants-legacy"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shopify_variants")
        .select("*, shopify_products(title)")
        .order("stock", { ascending: true });
      if (error) throw error;
      return data;
    },
  });
}

type VariantsQueryParams = {
  page: number;
  pageSize: number;
  search?: string;
  locationFilter?: string;
  fromDate?: string;
  toDate?: string;
  sortBy?: "stock" | "updated_at" | "price" | "sku";
  sortDir?: "asc" | "desc";
};

export function useVariantsPaginated(params: VariantsQueryParams) {
  const {
    page,
    pageSize,
    search = "",
    locationFilter = "all",
    fromDate,
    toDate,
    sortBy = "stock",
    sortDir = "asc",
  } = params;
  const fromIso = toStoreDayStartIso(fromDate);
  const toIso = toStoreDayEndExclusiveIso(toDate);
  return useQuery({
    queryKey: ["shopify-variants", page, pageSize, search, locationFilter, fromDate, toDate, sortBy, sortDir],
    queryFn: async () => {
      let query = supabase
        .from("shopify_variants")
        .select("*, shopify_products!inner(title)", { count: "exact" })
        .order(sortBy, { ascending: sortDir === "asc" });
      const q = search.trim();
      if (q) {
        const escaped = q.replace(/[%_]/g, "");
        query = query.or(`sku.ilike.%${escaped}%,shopify_products.title.ilike.%${escaped}%`);
      }
      if (locationFilter !== "all") query = query.eq("inventory_location", locationFilter);
      if (fromIso) query = query.gte("updated_at", fromIso);
      if (toIso) query = query.lt("updated_at", toIso);
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useInventoryLocations() {
  return useQuery({
    queryKey: ["shopify-inventory-locations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shopify_variants")
        .select("inventory_location")
        .not("inventory_location", "is", null)
        .limit(5000);
      if (error) throw error;
      const uniq = Array.from(new Set((data ?? []).map((r) => r.inventory_location).filter(Boolean))).sort();
      return ["all", ...uniq] as string[];
    },
    staleTime: 60_000,
  });
}

export function useSyncLogs(params?: { fromDate?: string; toDate?: string; sortDir?: "asc" | "desc"; forcePolling?: boolean }) {
  const { fromDate, toDate, sortDir = "desc", forcePolling = false } = params || {};
  const fromIso = toStoreDayStartIso(fromDate);
  const toIso = toStoreDayEndExclusiveIso(toDate);
  return useQuery({
    queryKey: ["sync-logs", fromDate, toDate, sortDir],
    queryFn: async () => {
      let query = supabase
        .from("sync_logs")
        .select("*")
        .order("started_at", { ascending: sortDir === "asc" })
        .limit(50);
      if (fromIso) query = query.gte("started_at", fromIso);
      if (toIso) query = query.lt("started_at", toIso);
      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    refetchInterval: (query) => {
      if (forcePolling) return 2500;
      const rows = query.state.data as { status: string }[] | undefined;
      if (!rows?.length) return false;
      return rows.some((r) => r.status === "running") ? 2500 : false;
    },
  });
}

export function useWebhookEvents(params?: {
  fromDate?: string;
  toDate?: string;
  sortDir?: "asc" | "desc";
  topic?: string;
  forcePolling?: boolean;
}) {
  const { fromDate, toDate, sortDir = "desc", topic = "all", forcePolling = false } = params || {};
  const fromIso = toStoreDayStartIso(fromDate);
  const toIso = toStoreDayEndExclusiveIso(toDate);
  return useQuery({
    queryKey: ["shopify-webhook-events", fromDate, toDate, sortDir, topic],
    queryFn: async () => {
      let query = supabase
        .from("shopify_webhook_events")
        .select("*")
        .order("received_at", { ascending: sortDir === "asc" })
        .limit(100);
      if (fromIso) query = query.gte("received_at", fromIso);
      if (toIso) query = query.lt("received_at", toIso);
      if (topic !== "all") query = query.eq("topic", topic);
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
    refetchInterval: (query) => {
      if (forcePolling) return 2500;
      const rows = query.state.data as { status: string }[] | undefined;
      if (!rows?.length) return false;
      return rows.some((r) => r.status === "processing") ? 2500 : 5000;
    },
  });
}

type CollectionsQueryParams = {
  page: number;
  pageSize: number;
  search?: string;
  fromDate?: string;
  toDate?: string;
  sortBy?: "title" | "updated_at";
  sortDir?: "asc" | "desc";
};

export function useCollectionsPaginated(params: CollectionsQueryParams) {
  const { page, pageSize, search = "", fromDate, toDate, sortBy = "updated_at", sortDir = "desc" } = params;
  const fromIso = toStoreDayStartIso(fromDate);
  const toIso = toStoreDayEndExclusiveIso(toDate);
  return useQuery({
    queryKey: ["shopify-collections", page, pageSize, search, fromDate, toDate, sortBy, sortDir],
    queryFn: async () => {
      let query = (supabase as any)
        .from("shopify_collections")
        .select("*", { count: "exact" })
        .order(sortBy, { ascending: sortDir === "asc" });
      const q = search.trim();
      if (q) {
        const escaped = q.replace(/[%_]/g, "");
        query = query.or(`title.ilike.%${escaped}%,handle.ilike.%${escaped}%`);
      }
      if (fromIso) query = query.gte("updated_at", fromIso);
      if (toIso) query = query.lt("updated_at", toIso);
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

type PurchaseOrdersQueryParams = {
  page: number;
  pageSize: number;
  search?: string;
  statusFilter?: string;
  fromDate?: string;
  toDate?: string;
  sortBy?: "po_date" | "expected_date" | "total_amount" | "supplier_name";
  sortDir?: "asc" | "desc";
};

export function usePurchaseOrdersPaginated(params: PurchaseOrdersQueryParams) {
  const {
    page,
    pageSize,
    search = "",
    statusFilter = "all",
    fromDate,
    toDate,
    sortBy = "po_date",
    sortDir = "desc",
  } = params;
  const fromIso = toStoreDayStartIso(fromDate);
  const toIso = toStoreDayEndExclusiveIso(toDate);
  return useQuery({
    queryKey: ["purchase-orders", page, pageSize, search, statusFilter, fromDate, toDate, sortBy, sortDir],
    queryFn: async () => {
      let query = (supabase as any)
        .from("purchase_orders")
        .select("*", { count: "exact" })
        .order(sortBy, { ascending: sortDir === "asc", nullsFirst: false });
      const q = search.trim();
      if (q) {
        const escaped = q.replace(/[%_]/g, "");
        query = query.or(`po_number.ilike.%${escaped}%,supplier_name.ilike.%${escaped}%,notes.ilike.%${escaped}%`);
      }
      if (statusFilter !== "all") query = query.eq("status", statusFilter);
      if (fromIso) query = query.gte("po_date", fromIso);
      if (toIso) query = query.lt("po_date", toIso);
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export type ShopifySyncModule = "customers" | "orders" | "products" | "collections" | "purchase_orders";

/**
 * Optional sync flags passed to the shopify-sync edge function.
 * - reset_customer_checkpoint: re-walk customers from newest (clears incremental updatedAt window).
 * - reset_orders_checkpoint: re-walk orders from newest (clears incremental window; backfills e.g. original_total).
 */
export type TriggerSyncOptions = {
  reset_customer_checkpoint?: boolean;
  reset_orders_checkpoint?: boolean;
};

export type OrderFinancialRefreshOptions = {
  /** Numeric Shopify order IDs or full `gid://shopify/Order/...` (max 40 per call). */
  shopify_order_ids?: string[];
  /** Also enqueue orders where status is refunded-like but current_total still equals total (RPC; max 40 total with explicit ids). */
  auto_stale_refunded_totals_match?: boolean;
};

export async function triggerOrderFinancialRefresh(options: OrderFinancialRefreshOptions) {
  await assertLicenseActive();
  const accessToken = await getAccessTokenForEdgeFunctions();
  if (!accessToken) {
    throw new Error("Your session expired. Please sign in again.");
  }
  const body: Record<string, unknown> = {};
  if (options.shopify_order_ids?.length) {
    body.refresh_shopify_order_ids = options.shopify_order_ids.slice(0, 40);
  }
  if (options.auto_stale_refunded_totals_match) {
    body.refresh_auto_stale_financial = true;
  }
  if (!body.refresh_shopify_order_ids && !body.refresh_auto_stale_financial) {
    throw new Error("Provide shopify_order_ids and/or enable auto_stale_refunded_totals_match.");
  }
  try {
    const { data, error } = await supabase.functions.invoke("shopify-sync", {
      body,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      timeout: 180_000,
    });
    if (error) {
      throw new Error(`Order refresh failed: ${error.message}`);
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown order refresh error";
    if (/Failed to fetch|Load failed|NetworkError/i.test(msg)) {
      throw new Error(
        "Order refresh was interrupted (network or gateway timeout). Deploy shopify-sync with order_financial_refresh support and try again.",
      );
    }
    throw err;
  }
}

async function assertLicenseActive() {
  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["datapulse_access_code", "datapulse_access_expires_at", "datapulse_license_mode"]);
  if (error) throw error;
  const rows = data ?? [];
  const code = rows.find((r) => r.key === "datapulse_access_code")?.value?.trim();
  const expiresAt = rows.find((r) => r.key === "datapulse_access_expires_at")?.value?.trim();
  const mode = rows.find((r) => r.key === "datapulse_license_mode")?.value?.trim();
  if (!code) {
    throw new Error("Sync locked: add and validate a DataPulse access code in Settings.");
  }
  if (mode === "lifetime") return;
  if (!expiresAt || Number.isNaN(new Date(expiresAt).getTime()) || new Date(expiresAt).getTime() <= Date.now()) {
    throw new Error("Sync locked: DataPulse access code expired. Validate a new code in Settings.");
  }
}

export async function triggerSync(module?: ShopifySyncModule, options?: TriggerSyncOptions) {
  await assertLicenseActive();
  const accessToken = await getAccessTokenForEdgeFunctions();
  if (!accessToken) {
    throw new Error("Your session expired. Please sign in again.");
  }
  try {
    const { data, error } = await supabase.functions.invoke("shopify-sync", {
      body: {
        ...(module ? { module } : {}),
        ...(options?.reset_customer_checkpoint ? { reset_customer_checkpoint: true } : {}),
        ...(options?.reset_orders_checkpoint ? { reset_orders_checkpoint: true } : {}),
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      // Sync can take minutes (customers → orders → products); default fetch timeout is too short.
      timeout: 400_000,
    });

    if (error) {
      throw new Error(`Sync failed: ${error.message}`);
    }

    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown sync error";
    // Browser "Failed to fetch" commonly appears when the function hit runtime/gateway timeout.
    if (/Failed to fetch|Load failed|NetworkError/i.test(msg)) {
      throw new Error(
        "Sync request was interrupted (likely runtime timeout/rate limit). Progress is saved in Sync Logs; run sync again to continue.",
      );
    }
    throw err;
  }
}

type SyncModuleResult = { synced?: number; status?: string; note?: string; error?: string };

function moduleUpToDate(mod?: SyncModuleResult) {
  if (!mod || mod.status !== "success") return false;
  const note = (mod.note || "").toLowerCase();
  // Backend still expects more runs — must not show "up to date"
  if (note.includes("stopped early to avoid runtime timeout")) return false;
  if (note.includes("run sync again")) return false;
  if (note.includes("stopped at ") && note.includes("pages")) return false;
  if (note.includes("already up to date")) return true;
  if (note.includes("incremental window:")) return true;
  // Success with zero writes only when nothing signaled continuation above (e.g. PO pass matched 0 rows).
  return Number(mod.synced ?? 0) === 0;
}

export type TriggerSyncUntilUpToDateOptions = {
  /** First run only: clears customers checkpoint so incremental updatedAt window does not skip everyone. */
  resetCustomerCheckpointFirstRun?: boolean;
  /** First run only: clears orders checkpoint so incremental window does not skip re-fetching existing orders. */
  resetOrdersCheckpointFirstRun?: boolean;
};

export async function triggerSyncUntilUpToDate(
  maxRuns = 20,
  module?: ShopifySyncModule,
  untilOptions?: TriggerSyncUntilUpToDateOptions,
) {
  let runs = 0;
  let lastResult: any = null;

  while (runs < maxRuns) {
    runs++;
    const resetCustomer =
      untilOptions?.resetCustomerCheckpointFirstRun === true && runs === 1 && module === "customers";
    const resetOrders =
      untilOptions?.resetOrdersCheckpointFirstRun === true && runs === 1 && module === "orders";
    lastResult = await triggerSync(
      module,
      resetCustomer
        ? { reset_customer_checkpoint: true }
        : resetOrders
          ? { reset_orders_checkpoint: true }
          : undefined,
    );
    const r = lastResult?.results || {};
    if (module) {
      if (moduleUpToDate(r[module])) {
        return { runs, completed: true, result: lastResult };
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }
    const customersDone = moduleUpToDate(r.customers);
    const ordersDone = moduleUpToDate(r.orders);
    const productsDone = moduleUpToDate(r.products);
    const collectionsDone = !r.collections || moduleUpToDate(r.collections);
    const purchaseOrdersDone = !r.purchase_orders || moduleUpToDate(r.purchase_orders);

    if (customersDone && ordersDone && productsDone && collectionsDone && purchaseOrdersDone) {
      return { runs, completed: true, result: lastResult };
    }

    // Small gap between runs to reduce burst pressure.
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return { runs, completed: false, result: lastResult };
}
