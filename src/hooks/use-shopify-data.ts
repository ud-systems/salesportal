import { supabase } from "@/integrations/supabase/client";
import { getAccessTokenForEdgeFunctions } from "@/lib/supabase-edge-auth";
import { devError } from "@/lib/dev-logger";
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

export type TimeseriesPoint = {
  label: string;
  revenue: number;
  orders: number;
};

export type TeamMemberOption = {
  user_id: string;
  label: string;
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
    queryFn: async () => {
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
    },
    staleTime: 60_000,
    enabled: enabled && Boolean(viewerUserId),
  });
}

export function useSalespersonPerformance(scopeKey = "global") {
  return useQuery({
    queryKey: ["salesperson-performance", scopeKey],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_salesperson_performance_rows", {
        _leader_user_id: null,
        _leader_role: null,
      });
      if (error) throw error;
      return ((data ?? []) as SalespersonPerformanceRow[]).map((row) => ({
        ...row,
        customers_count: Number(row.customers_count || 0),
        orders_count: Number(row.orders_count || 0),
        revenue: Number(row.revenue || 0),
      }));
    },
    staleTime: 60_000,
  });
}

export function useDirectReportSalesPerformance(
  leaderUserId: string | undefined,
  leaderRole: "manager" | "supervisor",
  scopeKey = "global",
) {
  return useQuery({
    queryKey: ["direct-report-sales-performance", leaderUserId ?? "none", leaderRole, scopeKey],
    queryFn: async () => {
      if (!leaderUserId) return [];
      const { data, error } = await supabase.rpc("get_salesperson_performance_rows", {
        _leader_user_id: leaderUserId,
        _leader_role: leaderRole,
      });
      if (error) throw error;
      return ((data ?? []) as SalespersonPerformanceRow[]).map((row) => ({
        ...row,
        customers_count: Number(row.customers_count || 0),
        orders_count: Number(row.orders_count || 0),
        revenue: Number(row.revenue || 0),
      }));
    },
    staleTime: 60_000,
    enabled: Boolean(leaderUserId),
  });
}

export function useSupervisorManagerScopePerformance(supervisorUserId: string | undefined, scopeKey = "global") {
  return useQuery({
    queryKey: ["supervisor-manager-scope-performance", supervisorUserId ?? "none", scopeKey],
    queryFn: async () => {
      if (!supervisorUserId) return [];
      const { data, error } = await supabase.rpc("get_supervisor_manager_scope_scorecards", {
        _supervisor_user_id: supervisorUserId,
      });
      if (error) throw error;
      return (data ?? []) as (ViewerScopePerformanceRow & { manager_name: string })[];
    },
    staleTime: 60_000,
    enabled: Boolean(supervisorUserId),
  });
}

export function useManagerTeamMemberOptions(managerUserId: string | undefined, scopeKey = "global") {
  return useQuery({
    queryKey: ["manager-team-member-options", managerUserId ?? "none", scopeKey],
    queryFn: async () => {
      if (!managerUserId) return [] as TeamMemberOption[];
      const { data, error } = await supabase.rpc("get_salesperson_performance_rows", {
        _leader_user_id: managerUserId,
        _leader_role: "manager",
      });
      if (error) throw error;
      return ((data ?? []) as SalespersonPerformanceRow[]).map((row) => ({
        user_id: row.salesperson_user_id,
        label: row.salesperson_name || "Salesperson",
      }));
    },
    staleTime: 60_000,
    enabled: Boolean(managerUserId),
  });
}

export function useSupervisorManagerOptions(supervisorUserId: string | undefined, scopeKey = "global") {
  return useQuery({
    queryKey: ["supervisor-manager-options", supervisorUserId ?? "none", scopeKey],
    queryFn: async () => {
      if (!supervisorUserId) return [] as TeamMemberOption[];
      const { data, error } = await supabase.rpc("get_supervisor_manager_scope_scorecards", {
        _supervisor_user_id: supervisorUserId,
      });
      if (error) throw error;
      const rows = (data ?? []) as (ViewerScopePerformanceRow & { manager_name: string })[];
      return rows
        .filter((row) => row.viewer_role === "manager")
        .map((row) => ({
          user_id: row.viewer_user_id,
          label: row.manager_name || "Manager",
        }));
    },
    staleTime: 60_000,
    enabled: Boolean(supervisorUserId),
  });
}

export function useSupervisorSalespersonOptions(supervisorUserId: string | undefined, scopeKey = "global") {
  return useQuery({
    queryKey: ["supervisor-salesperson-options", supervisorUserId ?? "none", scopeKey],
    queryFn: async () => {
      if (!supervisorUserId) return [] as TeamMemberOption[];
      const { data, error } = await supabase.rpc("get_salesperson_performance_rows", {
        _leader_user_id: supervisorUserId,
        _leader_role: "supervisor",
      });
      if (error) throw error;
      return ((data ?? []) as SalespersonPerformanceRow[]).map((row) => ({
        user_id: row.salesperson_user_id,
        label: row.salesperson_name || "Salesperson",
      }));
    },
    staleTime: 60_000,
    enabled: Boolean(supervisorUserId),
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

  let customerRows: { id: string; shopify_customer_id: string | null }[] = [];
  for (const part of splitIntoChunks(customerIds, 200)) {
    const { data, error } = await supabase
      .from("shopify_customers")
      .select("id, shopify_customer_id")
      .in("id", part);
    if (error) throw error;
    customerRows = customerRows.concat((data ?? []) as { id: string; shopify_customer_id: string | null }[]);
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

  const orderMap = new Map<string, { total: number; at: string }>();
  const absorbOrders = (rows: { id: string; total: number | null; shopify_created_at: string | null; created_at: string | null }[]) => {
    for (const row of rows) {
      if (orderMap.has(row.id)) continue;
      const at = row.shopify_created_at || row.created_at;
      if (!at) continue;
      if (!isInRange(at)) continue;
      orderMap.set(row.id, { total: Number(row.total || 0), at });
    }
  };

  for (const part of splitIntoChunks(customerIds, 200)) {
    const query = supabase
      .from("shopify_orders")
      .select("id, total, shopify_created_at, created_at")
      .in("customer_id", part);
    const { data, error } = await query;
    if (error) throw error;
    absorbOrders((data ?? []) as { id: string; total: number | null; shopify_created_at: string | null; created_at: string | null }[]);
  }

  for (const part of splitIntoChunks(shopifyCustomerIds, 200)) {
    const query = supabase
      .from("shopify_orders")
      .select("id, total, shopify_created_at, created_at")
      .is("customer_id", null)
      .in("shopify_customer_id", part);
    const { data, error } = await query;
    if (error) throw error;
    absorbOrders((data ?? []) as { id: string; total: number | null; shopify_created_at: string | null; created_at: string | null }[]);
  }

  const seriesMap = new Map<string, TimeseriesPoint & { sortKey: string }>();
  let revenue = 0;
  let ordersCount = 0;

  for (const [, order] of orderMap) {
    revenue += order.total;
    ordersCount += 1;
    const date = new Date(order.at);
    let key: string;
    let label: string;
    if (bucket === "day") {
      key = date.toISOString().slice(0, 10);
      label = new Date(key + "T12:00:00Z").toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        timeZone: "UTC",
      });
    } else {
      key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
      label = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toLocaleDateString("en-GB", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
    }
    const prev = seriesMap.get(key) || { label, revenue: 0, orders: 0, sortKey: key };
    prev.revenue += order.total;
    prev.orders += 1;
    seriesMap.set(key, prev);
  }

  const series = Array.from(seriesMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => ({ label: v.label, revenue: v.revenue, orders: v.orders }));

  return {
    orders_count: ordersCount,
    customers_count: customerIds.length,
    revenue,
    avg_order_value: ordersCount > 0 ? revenue / ordersCount : 0,
    series,
  };
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
    queryFn: () => fetchScopedMetricsAndSeriesBySalespeople(salespersonUserIds, fromIso, toIso, bucket),
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
      let rows: { member_user_id: string }[] = [];
      for (const part of splitIntoChunks(managerUserIds, 200)) {
        const { data, error } = await supabase
          .from("sales_hierarchy_edges")
          .select("member_user_id")
          .eq("leader_role", "manager")
          .in("leader_user_id", part);
        if (error) throw error;
        rows = rows.concat((data ?? []) as { member_user_id: string }[]);
      }
      return Array.from(new Set(rows.map((r) => r.member_user_id).filter(Boolean)));
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
      const metrics = await Promise.all(
        viewerUserIds.map(async (viewerId) => {
          const { data, error } = await supabase.rpc("get_scope_order_metrics", {
            _viewer_user_id: viewerId,
            _from_iso: fromIso ?? null,
            _to_iso: toIso ?? null,
          });
          if (error) throw error;
          const row = (data?.[0] ?? {}) as Partial<ScopeOrderMetrics>;
          return {
            orders_count: Number(row.orders_count || 0),
            customers_count: Number(row.customers_count || 0),
            revenue: Number(row.revenue || 0),
          };
        }),
      );
      const totals = metrics.reduce(
        (acc, row) => {
          acc.orders_count += row.orders_count;
          acc.customers_count += row.customers_count;
          acc.revenue += row.revenue;
          return acc;
        },
        { orders_count: 0, customers_count: 0, revenue: 0 },
      );
      return {
        ...totals,
        avg_order_value: totals.orders_count > 0 ? totals.revenue / totals.orders_count : 0,
      } satisfies ScopeOrderMetrics;
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
    queryFn: async () => {
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
    },
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
    queryFn: async () => {
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
    },
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
  fromDate?: string;
  toDate?: string;
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
    fromDate,
    toDate,
    sortBy = "total_revenue",
    sortDir = "desc",
    scopeSalespersonIds = [],
    scopeCustomerIds = [],
    scopeOwnerNames = [],
    forceScopedFilter = false,
    enabled = true,
  } = params;
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
      fromDate,
      toDate,
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
      if (requestedScopedFilter && scopedCustomerIdsFinal.length === 0) {
        if (scopedSalespeopleFinal.length === 0 && scopedOwnerNamesFinal.length === 0) {
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
          _from_iso: fromDate ? `${fromDate}T00:00:00.000Z` : null,
          _to_iso: toDate ? `${toDate}T23:59:59.999Z` : null,
          _sort_by: sortBy,
          _sort_dir: sortDir,
          _page: page,
          _page_size: pageSize,
          _force_scoped_filter: true,
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
      if (fromDate) query = query.gte("shopify_created_at", `${fromDate}T00:00:00.000Z`);
      if (toDate) query = query.lte("shopify_created_at", `${toDate}T23:59:59.999Z`);
      if (assignmentFilter === "assigned") {
        query = query.not("sp_assigned", "is", null).neq("sp_assigned", "Unassigned");
      } else if (assignmentFilter === "unassigned") {
        query = query.or("sp_assigned.is.null,sp_assigned.eq.Unassigned");
      }
      if (scopedCustomerIdsFinal.length > 0) {
        // Large `.in(...)` lists can exceed URL limits on PostgREST.
        // Fetch in chunks and paginate in-memory to avoid oversized query strings.
        const allRows: any[] = [];
        const seenCustomerIds = new Set<string>();
        for (const part of splitIntoChunks(scopedCustomerIdsFinal, 150)) {
          const batchSize = 1000;
          let offset = 0;
          while (true) {
            let scopedChunkQuery = supabase
              .from("shopify_customers")
              .select("*")
              .in("id", part);
            if (q) {
              const escaped = q.replace(/[%_]/g, "");
              scopedChunkQuery = scopedChunkQuery.or(`name.ilike.%${escaped}%,city.ilike.%${escaped}%,email.ilike.%${escaped}%`);
            }
            if (cityFilter !== "all") scopedChunkQuery = scopedChunkQuery.eq("city", cityFilter);
            if (fromDate) scopedChunkQuery = scopedChunkQuery.gte("shopify_created_at", `${fromDate}T00:00:00.000Z`);
            if (toDate) scopedChunkQuery = scopedChunkQuery.lte("shopify_created_at", `${toDate}T23:59:59.999Z`);
            if (assignmentFilter === "assigned") {
              scopedChunkQuery = scopedChunkQuery.not("sp_assigned", "is", null).neq("sp_assigned", "Unassigned");
            } else if (assignmentFilter === "unassigned") {
              scopedChunkQuery = scopedChunkQuery.or("sp_assigned.is.null,sp_assigned.eq.Unassigned");
            }

            const { data: chunkRows, error: chunkError } = await scopedChunkQuery.range(offset, offset + batchSize - 1);
            if (chunkError) throw chunkError;

            const rows = chunkRows ?? [];
            for (const row of rows) {
              if (!row?.id || seenCustomerIds.has(row.id)) continue;
              seenCustomerIds.add(row.id);
              allRows.push(row);
            }
            if (rows.length < batchSize) break;
            offset += batchSize;
          }
        }

        const dir = sortDir === "asc" ? 1 : -1;
        const toComparable = (value: unknown): number | string => {
          if (value === null || value === undefined) return "";
          if (typeof value === "number") return value;
          if (typeof value === "string") {
            const asTime = Date.parse(value);
            if (!Number.isNaN(asTime)) return asTime;
            const asNum = Number(value);
            return Number.isNaN(asNum) ? value.toLowerCase() : asNum;
          }
          return String(value).toLowerCase();
        };

        allRows.sort((a, b) => {
          const av = toComparable(a?.[sortBy]);
          const bv = toComparable(b?.[sortBy]);
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });

        const from = (page - 1) * pageSize;
        const to = from + pageSize;
        return { data: allRows.slice(from, to), count: allRows.length };
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
        month: new Date(Date.UTC(2020, i, 1)).toLocaleString("en", { month: "short", timeZone: "UTC" }),
        revenue: 0,
        orders: 0,
        year: activeYear,
      }));

      for (const row of rows) {
        const d = row.shopify_created_at || row.created_at;
        if (!d) continue;
        const parsed = new Date(d);
        if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() !== activeYear) continue;
        const idx = parsed.getUTCMonth();
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
          .select("total")
          .range(from, to);
        if (error) throw error;
        const batch = data ?? [];
        for (const row of batch) total += Number((row as any).total || 0);
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
    let q = supabase.from("shopify_orders").select("total");
    if (fromIso) q = q.gte("shopify_created_at", fromIso);
    if (toIso) q = q.lte("shopify_created_at", toIso);
    const to = offset + pageSize - 1;
    const { data, error } = await q.range(offset, to);
    if (error) throw error;
    const batch = data ?? [];
    count += batch.length;
    for (const row of batch) revenue += Number((row as { total?: number }).total || 0);
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
      if (toIso) q = q.lte("shopify_created_at", toIso);
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
      const rows: { shopify_created_at: string | null; created_at: string | null; total: number | null }[] = [];
      while (true) {
        let q = supabase.from("shopify_orders").select("shopify_created_at, created_at, total");
        if (fromIso) q = q.gte("shopify_created_at", fromIso);
        if (toIso) q = q.lte("shopify_created_at", toIso);
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
        const date = new Date(d);
        let key: string;
        let label: string;
        if (bucket === "day") {
          key = date.toISOString().slice(0, 10);
          label = new Date(key + "T12:00:00Z").toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            timeZone: "UTC",
          });
        } else {
          key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
          label = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toLocaleDateString("en-GB", {
            month: "short",
            year: "numeric",
            timeZone: "UTC",
          });
        }
        const prev = map.get(key) || { revenue: 0, orders: 0, label, sortKey: key };
        prev.revenue += Number(row.total || 0);
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
    queryFn: async () => {
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
    },
    staleTime: 60_000,
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
      if (toIso) q = q.lte("shopify_created_at", toIso);
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
    sortBy = "shopify_created_at",
    sortDir = "desc",
    scopeSalespersonIds = [],
    scopeCustomerIds = [],
    scopeOwnerNames = [],
    forceScopedFilter = false,
    enabled = true,
  } = params;
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
      sortBy,
      sortDir,
      salespersonScopeKey,
      scopeKey,
      ownerScopeKey,
    ],
    queryFn: async () => {
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
      if (fromDate) query = query.gte("shopify_created_at", `${fromDate}T00:00:00.000Z`);
      if (toDate) query = query.lte("shopify_created_at", `${toDate}T23:59:59.999Z`);
      const requestedScopedFilter =
        forceScopedFilter ||
        (params.scopeSalespersonIds?.length ?? 0) > 0 ||
        (params.scopeCustomerIds?.length ?? 0) > 0 ||
        (params.scopeOwnerNames?.length ?? 0) > 0;
      if (requestedScopedFilter) {
        const viewerUserId = (await supabase.auth.getUser()).data.user?.id;
        if (!viewerUserId) return { data: [], count: 0 };
        const scopedSalespeopleFinal = Array.from(new Set(scopeSalespersonIds.filter(Boolean)));
        const scopedOwnerNamesFinal = Array.from(new Set(scopeOwnerNames.map((name) => name.trim()).filter(Boolean)));
        const { data: scopedRows, error: scopedError } = await (supabase as any).rpc("get_scoped_orders_page", {
          _viewer_user_id: viewerUserId,
          _salesperson_user_ids: scopedSalespeopleFinal,
          _owner_names: scopedOwnerNamesFinal,
          _search: search || null,
          _status_filter: statusFilter,
          _fulfillment_filter: fulfillmentFilter,
          _from_iso: fromDate ? `${fromDate}T00:00:00.000Z` : null,
          _to_iso: toDate ? `${toDate}T23:59:59.999Z` : null,
          _sort_by: sortBy,
          _sort_dir: sortDir,
          _page: page,
          _page_size: pageSize,
          _force_scoped_filter: true,
        });
        if (scopedError) throw scopedError;
        const rows = (scopedRows ?? []) as { row_data: any; total_count: number | null }[];
        return {
          data: rows.map((r) => r.row_data).filter(Boolean),
          count: Number(rows[0]?.total_count ?? 0),
        };
      }
      const scopedCustomerIdsFinal = Array.from(new Set(scopeCustomerIds.filter(Boolean)));
      if (scopeSalespersonIds.length > 0) {
        const viewerUserId = (await supabase.auth.getUser()).data.user?.id;
        if (!viewerUserId) return { data: [], count: 0 };
        const scopedOrderIds = await fetchAllScopedOrderIdsForViewer(viewerUserId, scopeSalespersonIds);
        if (!scopedOrderIds.length) return { data: [], count: 0 };

        const allRows: any[] = [];
        const seenOrderIds = new Set<string>();
        for (const part of splitIntoChunks(scopedOrderIds, 150)) {
          const batchSize = 1000;
          let offset = 0;
          while (true) {
            let scopedChunkQuery = supabase
              .from("shopify_orders")
              .select("*")
              .in("id", part);
            if (q) {
              const escaped = q.replace(/[%_]/g, "");
              scopedChunkQuery = scopedChunkQuery.or(`order_number.ilike.%${escaped}%,customer_name.ilike.%${escaped}%`);
            }
            if (statusFilter !== "all") scopedChunkQuery = scopedChunkQuery.eq("financial_status", statusFilter);
            if (fulfillmentFilter !== "all") scopedChunkQuery = scopedChunkQuery.eq("fulfillment_status", fulfillmentFilter);
            if (fromDate) scopedChunkQuery = scopedChunkQuery.gte("shopify_created_at", `${fromDate}T00:00:00.000Z`);
            if (toDate) scopedChunkQuery = scopedChunkQuery.lte("shopify_created_at", `${toDate}T23:59:59.999Z`);

            const { data: chunkRows, error: chunkError } = await scopedChunkQuery.range(offset, offset + batchSize - 1);
            if (chunkError) throw chunkError;

            const rows = chunkRows ?? [];
            for (const row of rows) {
              if (!row?.id || seenOrderIds.has(row.id)) continue;
              seenOrderIds.add(row.id);
              allRows.push(row);
            }
            if (rows.length < batchSize) break;
            offset += batchSize;
          }
        }

        const dir = sortDir === "asc" ? 1 : -1;
        const toComparable = (value: unknown): number | string => {
          if (value === null || value === undefined) return "";
          if (typeof value === "number") return value;
          if (typeof value === "string") {
            const asTime = Date.parse(value);
            if (!Number.isNaN(asTime)) return asTime;
            const asNum = Number(value);
            return Number.isNaN(asNum) ? value.toLowerCase() : asNum;
          }
          return String(value).toLowerCase();
        };

        allRows.sort((a, b) => {
          const av = toComparable(a?.[sortBy]);
          const bv = toComparable(b?.[sortBy]);
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });

        const from = (page - 1) * pageSize;
        const to = from + pageSize;
        return { data: allRows.slice(from, to), count: allRows.length };
      }
      if (requestedScopedFilter && scopedCustomerIdsFinal.length === 0) {
        return { data: [], count: 0 };
      }
      if (scopedCustomerIdsFinal.length > 0) {
        // Large `.in(...)` lists can exceed URL limits on PostgREST.
        // Fetch in chunks and paginate in-memory to avoid 400 Bad Request.
        const allRows: any[] = [];
        const seenOrderIds = new Set<string>();
        let scopedShopifyCustomerIds: string[] = [];
        for (const part of splitIntoChunks(scopedCustomerIdsFinal, 200)) {
          const { data: customerRows, error: customerRowsError } = await supabase
            .from("shopify_customers")
            .select("shopify_customer_id")
            .in("id", part);
          if (customerRowsError) throw customerRowsError;
          for (const row of (customerRows ?? []) as { shopify_customer_id: string | null }[]) {
            if (row.shopify_customer_id) scopedShopifyCustomerIds.push(row.shopify_customer_id);
          }
        }
        scopedShopifyCustomerIds = Array.from(new Set(scopedShopifyCustomerIds));
        for (const part of splitIntoChunks(scopedCustomerIdsFinal, 150)) {
          const batchSize = 1000;
          let offset = 0;
          while (true) {
            let scopedChunkQuery = supabase
              .from("shopify_orders")
              .select("*")
              .in("customer_id", part);
            if (q) {
              const escaped = q.replace(/[%_]/g, "");
              scopedChunkQuery = scopedChunkQuery.or(`order_number.ilike.%${escaped}%,customer_name.ilike.%${escaped}%`);
            }
            if (statusFilter !== "all") scopedChunkQuery = scopedChunkQuery.eq("financial_status", statusFilter);
            if (fulfillmentFilter !== "all") scopedChunkQuery = scopedChunkQuery.eq("fulfillment_status", fulfillmentFilter);
            if (fromDate) scopedChunkQuery = scopedChunkQuery.gte("shopify_created_at", `${fromDate}T00:00:00.000Z`);
            if (toDate) scopedChunkQuery = scopedChunkQuery.lte("shopify_created_at", `${toDate}T23:59:59.999Z`);

            const { data: chunkRows, error: chunkError } = await scopedChunkQuery.range(offset, offset + batchSize - 1);
            if (chunkError) throw chunkError;

            const rows = chunkRows ?? [];
            for (const row of rows) {
              if (!row?.id || seenOrderIds.has(row.id)) continue;
              seenOrderIds.add(row.id);
              allRows.push(row);
            }
            if (rows.length < batchSize) break;
            offset += batchSize;
          }
        }
        for (const part of splitIntoChunks(scopedShopifyCustomerIds, 150)) {
          const batchSize = 1000;
          let offset = 0;
          while (true) {
            let scopedByShopifyCustomerQuery = supabase
              .from("shopify_orders")
              .select("*")
              .is("customer_id", null)
              .in("shopify_customer_id", part);
            if (q) {
              const escaped = q.replace(/[%_]/g, "");
              scopedByShopifyCustomerQuery = scopedByShopifyCustomerQuery.or(
                `order_number.ilike.%${escaped}%,customer_name.ilike.%${escaped}%`,
              );
            }
            if (statusFilter !== "all") scopedByShopifyCustomerQuery = scopedByShopifyCustomerQuery.eq("financial_status", statusFilter);
            if (fulfillmentFilter !== "all") scopedByShopifyCustomerQuery = scopedByShopifyCustomerQuery.eq("fulfillment_status", fulfillmentFilter);
            if (fromDate) scopedByShopifyCustomerQuery = scopedByShopifyCustomerQuery.gte("shopify_created_at", `${fromDate}T00:00:00.000Z`);
            if (toDate) scopedByShopifyCustomerQuery = scopedByShopifyCustomerQuery.lte("shopify_created_at", `${toDate}T23:59:59.999Z`);

            const { data: chunkRows, error: chunkError } = await scopedByShopifyCustomerQuery.range(
              offset,
              offset + batchSize - 1,
            );
            if (chunkError) throw chunkError;

            const rows = chunkRows ?? [];
            for (const row of rows) {
              if (!row?.id || seenOrderIds.has(row.id)) continue;
              seenOrderIds.add(row.id);
              allRows.push(row);
            }
            if (rows.length < batchSize) break;
            offset += batchSize;
          }
        }

        const dir = sortDir === "asc" ? 1 : -1;
        const toComparable = (value: unknown): number | string => {
          if (value === null || value === undefined) return "";
          if (typeof value === "number") return value;
          if (typeof value === "string") {
            const asTime = Date.parse(value);
            if (!Number.isNaN(asTime)) return asTime;
            const asNum = Number(value);
            return Number.isNaN(asNum) ? value.toLowerCase() : asNum;
          }
          return String(value).toLowerCase();
        };

        allRows.sort((a, b) => {
          const av = toComparable(a?.[sortBy]);
          const bv = toComparable(b?.[sortBy]);
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });

        const from = (page - 1) * pageSize;
        const to = from + pageSize;
        return { data: allRows.slice(from, to), count: allRows.length };
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
    enabled,
  });
}

export function useOrderItems(orderId?: string) {
  return useQuery({
    queryKey: ["shopify-order-items", orderId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shopify_order_items")
        .select("*")
        .eq("order_id", orderId!);
      if (error) throw error;
      return data;
    },
    enabled: !!orderId,
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
  return useQuery({
    queryKey: ["shopify-products", page, pageSize, search, statusFilter, fromDate, toDate, sortBy, sortDir],
    queryFn: async () => {
      let query = supabase
        .from("shopify_products")
        .select("*, shopify_variants(*)", { count: "exact" })
        .order(sortBy, { ascending: sortDir === "asc" });
      const q = search.trim();
      if (q) {
        const escaped = q.replace(/[%_]/g, "");
        query = query.or(`title.ilike.%${escaped}%,vendor.ilike.%${escaped}%,category.ilike.%${escaped}%`);
      }
      if (statusFilter !== "all") query = query.eq("status", statusFilter);
      if (fromDate) query = query.gte("updated_at", `${fromDate}T00:00:00.000Z`);
      if (toDate) query = query.lte("updated_at", `${toDate}T23:59:59.999Z`);
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
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
      if (fromDate) query = query.gte("updated_at", `${fromDate}T00:00:00.000Z`);
      if (toDate) query = query.lte("updated_at", `${toDate}T23:59:59.999Z`);
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
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
  return useQuery({
    queryKey: ["sync-logs", fromDate, toDate, sortDir],
    queryFn: async () => {
      let query = supabase
        .from("sync_logs")
        .select("*")
        .order("started_at", { ascending: sortDir === "asc" })
        .limit(50);
      if (fromDate) query = query.gte("started_at", `${fromDate}T00:00:00.000Z`);
      if (toDate) query = query.lte("started_at", `${toDate}T23:59:59.999Z`);
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
  return useQuery({
    queryKey: ["shopify-webhook-events", fromDate, toDate, sortDir, topic],
    queryFn: async () => {
      let query = supabase
        .from("shopify_webhook_events")
        .select("*")
        .order("received_at", { ascending: sortDir === "asc" })
        .limit(100);
      if (fromDate) query = query.gte("received_at", `${fromDate}T00:00:00.000Z`);
      if (toDate) query = query.lte("received_at", `${toDate}T23:59:59.999Z`);
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
      if (fromDate) query = query.gte("updated_at", `${fromDate}T00:00:00.000Z`);
      if (toDate) query = query.lte("updated_at", `${toDate}T23:59:59.999Z`);
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
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
      if (fromDate) query = query.gte("po_date", `${fromDate}T00:00:00.000Z`);
      if (toDate) query = query.lte("po_date", `${toDate}T23:59:59.999Z`);
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
  });
}

export type ShopifySyncModule = "customers" | "orders" | "products" | "collections" | "purchase_orders";

/** Clears the customers incremental window so the next run re-upserts all customers (up to page limits per run). */
export type TriggerSyncOptions = {
  reset_customer_checkpoint?: boolean;
};

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
    lastResult = await triggerSync(module, resetCustomer ? { reset_customer_checkpoint: true } : undefined);
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
