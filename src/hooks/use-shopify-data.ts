import { supabase } from "@/integrations/supabase/client";
import { getAccessTokenForEdgeFunctions } from "@/lib/supabase-edge-auth";
import { useQuery } from "@tanstack/react-query";

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
  } = params;
  return useQuery({
    queryKey: ["shopify-customers", page, pageSize, search, cityFilter, assignmentFilter, fromDate, toDate, sortBy, sortDir],
    queryFn: async () => {
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

      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
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

export function useOrdersCount() {
  return useQuery({
    queryKey: ["shopify-orders-count"],
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

export function useCustomersCount() {
  return useQuery({
    queryKey: ["shopify-customers-count"],
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

export function useTopCustomers(limit = 3) {
  return useQuery({
    queryKey: ["shopify-top-customers", limit],
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

export function useRecentOrders(limit = 10) {
  return useQuery({
    queryKey: ["shopify-recent-orders", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shopify_orders")
        .select("id, order_number, shopify_order_id, customer_name, total, financial_status, fulfillment_status, shopify_created_at, created_at")
        .order("shopify_created_at", { ascending: false, nullsFirst: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 30_000,
  });
}

export function useRevenueByMonthForYear(year?: number) {
  const activeYear = year ?? new Date().getUTCFullYear();
  return useQuery({
    queryKey: ["shopify-revenue-by-month", activeYear],
    queryFn: async () => {
      const start = `${activeYear}-01-01T00:00:00.000Z`;
      const end = `${activeYear}-12-31T23:59:59.999Z`;
      const { data, error } = await supabase
        .from("shopify_orders")
        .select("shopify_created_at, created_at, total")
        .gte("shopify_created_at", start)
        .lte("shopify_created_at", end);
      if (error) throw error;

      const months = Array.from({ length: 12 }, (_, i) => ({
        monthIdx: i,
        month: new Date(Date.UTC(2020, i, 1)).toLocaleString("en", { month: "short", timeZone: "UTC" }),
        revenue: 0,
        orders: 0,
        year: activeYear,
      }));

      for (const row of data ?? []) {
        const d = row.shopify_created_at || row.created_at;
        if (!d) continue;
        const idx = new Date(d).getUTCMonth();
        months[idx].revenue += Number(row.total || 0);
        months[idx].orders += 1;
      }
      return months;
    },
    staleTime: 60_000,
  });
}

export function useOrdersTotalRevenue() {
  return useQuery({
    queryKey: ["shopify-orders-total-revenue"],
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
  } = params;
  return useQuery({
    queryKey: ["shopify-orders", page, pageSize, search, statusFilter, fulfillmentFilter, fromDate, toDate, sortBy, sortDir],
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
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await query.range(from, to);
      if (error) throw error;
      return { data: data ?? [], count: count ?? 0 };
    },
    placeholderData: (previousData) => previousData,
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
