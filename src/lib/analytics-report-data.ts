import { supabase } from "@/integrations/supabase/client";

export type ReportFetchParams = {
  fromIso: string | null;
  toIso: string | null;
  currency: string;
  viewerUserId?: string;
  lowStockThreshold?: number;
};

export type ReportDefinition = {
  id: string;
  title: string;
  description: string;
  /** If true, fromIso and toIso must be set */
  requiresRange: boolean;
};

export const ANALYTICS_REPORTS: ReportDefinition[] = [
  {
    id: "sales_summary",
    title: "Sales summary",
    description: "KPI totals: revenue, orders, tax, subtotal, average order value for the period.",
    requiresRange: true,
  },
  {
    id: "orders_detail",
    title: "Orders detail",
    description: "Every order in the period with customer, totals, payment and fulfillment status.",
    requiresRange: true,
  },
  {
    id: "line_items",
    title: "Line items",
    description: "All line items sold in the period with order reference, SKU, quantity and line revenue.",
    requiresRange: true,
  },
  {
    id: "top_products",
    title: "Top products by revenue",
    description: "Products ranked by revenue and units sold in the period (from order lines).",
    requiresRange: true,
  },
  {
    id: "top_customers",
    title: "Top customers by revenue",
    description: "Customers ranked by order revenue and order count in the period.",
    requiresRange: true,
  },
  {
    id: "payment_status",
    title: "Revenue by payment status",
    description: "Totals grouped by financial status (paid, pending, refunded, etc.).",
    requiresRange: true,
  },
  {
    id: "fulfillment_status",
    title: "Orders by fulfillment",
    description: "Order counts and revenue grouped by fulfillment status.",
    requiresRange: true,
  },
  {
    id: "tax_summary",
    title: "Tax & totals",
    description: "Subtotal, tax and grand total rolled up for the period.",
    requiresRange: true,
  },
  {
    id: "sales_by_salesperson",
    title: "Revenue by salesperson",
    description: "Identity-based attribution from salesperson/customer assignment mappings.",
    requiresRange: true,
  },
  {
    id: "inventory_snapshot",
    title: "Inventory snapshot",
    description: "All variants with SKU, stock, price and product title (current, not date-filtered).",
    requiresRange: false,
  },
  {
    id: "low_stock",
    title: "Low & out of stock",
    description: "Variants at or below your threshold (default 10 units).",
    requiresRange: false,
  },
  {
    id: "customer_directory",
    title: "Customer directory",
    description: "Customers with orders, revenue, spend currency, city and assigned salesperson.",
    requiresRange: false,
  },
  {
    id: "manager_performance",
    title: "Manager performance",
    description: "Team performance rollups for users with manager role.",
    requiresRange: true,
  },
  {
    id: "supervisor_performance",
    title: "Supervisor performance",
    description: "Team performance rollups for users with supervisor role.",
    requiresRange: true,
  },
  {
    id: "team_performance",
    title: "Team performance overview",
    description: "Per-viewer team rollups across hierarchy scopes.",
    requiresRange: true,
  },
];

const PAGE = 500;

async function paginateScopedOrdersInRange(
  viewerUserId: string,
  fromIso: string,
  toIso: string,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let page = 1;
  while (true) {
    const { data, error } = await (supabase as any).rpc("get_scoped_orders_page", {
      _viewer_user_id: viewerUserId,
      _salesperson_user_ids: [],
      _owner_names: [],
      _search: null,
      _status_filter: "all",
      _fulfillment_filter: "all",
      _from_iso: fromIso,
      _to_iso: toIso,
      _sort_by: "shopify_created_at",
      _sort_dir: "desc",
      _page: page,
      _page_size: PAGE,
      _force_scoped_filter: true,
    });
    if (error) throw error;
    const rows = (data ?? []) as { row_data?: Record<string, unknown> | null; total_count?: number | null }[];
    const batch = rows.map((r) => r.row_data).filter((r): r is Record<string, unknown> => Boolean(r));
    all.push(...batch);
    if (batch.length < PAGE) break;
    page += 1;
  }
  return all;
}

async function paginateScopedCustomers(
  viewerUserId: string,
  fromIso: string | null,
  toIso: string | null,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let page = 1;
  while (true) {
    const { data, error } = await (supabase as any).rpc("get_scoped_customers_page", {
      _viewer_user_id: viewerUserId,
      _salesperson_user_ids: [],
      _owner_names: [],
      _search: null,
      _city_filter: "all",
      _assignment_filter: "all",
      _from_iso: fromIso,
      _to_iso: toIso,
      _sort_by: "total_revenue",
      _sort_dir: "desc",
      _page: page,
      _page_size: PAGE,
      _force_scoped_filter: true,
    });
    if (error) throw error;
    const rows = (data ?? []) as { row_data?: Record<string, unknown> | null; total_count?: number | null }[];
    const batch = rows.map((r) => r.row_data).filter((r): r is Record<string, unknown> => Boolean(r));
    all.push(...batch);
    if (batch.length < PAGE) break;
    page += 1;
  }
  return all;
}

async function paginateScopedOrderItemsInRange(
  viewerUserId: string,
  fromIso: string,
  toIso: string,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let page = 1;
  while (true) {
    const { data, error } = await (supabase as any).rpc("get_scoped_order_items_page", {
      _viewer_user_id: viewerUserId,
      _salesperson_user_ids: [],
      _owner_names: [],
      _from_iso: fromIso,
      _to_iso: toIso,
      _page: page,
      _page_size: PAGE,
      _force_scoped_filter: true,
    });
    if (error) throw error;
    const rows = (data ?? []) as { row_data?: Record<string, unknown> | null; total_count?: number | null }[];
    const batch = rows.map((r) => r.row_data).filter((r): r is Record<string, unknown> => Boolean(r));
    all.push(...batch);
    if (batch.length < PAGE) break;
    page += 1;
  }
  return all;
}

async function paginateOrdersInRange(
  fromIso: string,
  toIso: string,
  select: string,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("shopify_orders")
      .select(select)
      .gte("shopify_created_at", fromIso)
      .lte("shopify_created_at", toIso)
      .order("shopify_created_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const batch = data ?? [];
    all.push(...batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getUserNameMap(viewerUserId: string | undefined, userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!viewerUserId || !userIds.length) return map;
  const { data, error } = await (supabase as any).rpc("get_scoped_user_display_names", {
    _viewer_user_id: viewerUserId,
    _target_user_ids: userIds,
  });
  if (error) throw error;
  for (const row of (data ?? []) as { user_id?: string | null; display_name?: string | null }[]) {
    const userId = String(row.user_id ?? "");
    const displayName = String(row.display_name ?? "").trim();
    if (userId && displayName) map.set(userId, displayName);
  }
  return map;
}

export async function fetchReportData(
  reportId: string,
  params: ReportFetchParams,
): Promise<{ columns: string[]; rows: (string | number)[][] }> {
  const { fromIso, toIso, currency, viewerUserId, lowStockThreshold = 10 } = params;

  if (ANALYTICS_REPORTS.find((r) => r.id === reportId)?.requiresRange && (!fromIso || !toIso)) {
    throw new Error("Select a date range for this report.");
  }

  switch (reportId) {
    case "sales_summary": {
      if (!viewerUserId) throw new Error("Missing viewer context for sales summary.");
      const { data, error } = await supabase.rpc("get_scope_order_metrics", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso!,
        _to_iso: toIso!,
      });
      if (error) throw error;
      const metrics = (data?.[0] ?? {}) as {
        orders_count?: number;
        customers_count?: number;
        revenue?: number;
        avg_order_value?: number;
      };
      return {
        columns: ["Metric", "Value"],
        rows: [
          ["Orders", Number(metrics.orders_count || 0)],
          ["Customers", Number(metrics.customers_count || 0)],
          ["Gross revenue (order total)", Number(metrics.revenue || 0).toFixed(2)],
          ["Average order value", Number(metrics.avg_order_value || 0).toFixed(2)],
          ["Display currency", currency],
        ],
      };
    }

    case "orders_detail": {
      if (!viewerUserId) throw new Error("Missing viewer context for orders detail.");
      const orders = await paginateScopedOrdersInRange(viewerUserId, fromIso!, toIso!);
      return {
        columns: [
          "Order",
          "Customer",
          "Email",
          "Total",
          "Subtotal",
          "Tax",
          "Currency",
          "Payment",
          "Fulfillment",
          "Date",
          "Test",
        ],
        rows: orders.map((o) => {
          const r = o as Record<string, unknown>;
          return [
            String(r.order_number ?? ""),
            String(r.customer_name ?? ""),
            String(r.email ?? ""),
            Number(r.total || 0),
            Number(r.subtotal || 0),
            Number(r.total_tax || 0),
            String(r.currency_code ?? currency),
            String(r.financial_status ?? ""),
            String(r.fulfillment_status ?? ""),
            String(r.shopify_created_at ?? ""),
            r.test_order ? "Yes" : "No",
          ];
        }),
      };
    }

    case "line_items": {
      if (!viewerUserId) throw new Error("Missing viewer context for line items.");
      const scopedItems = await paginateScopedOrderItemsInRange(viewerUserId, fromIso!, toIso!);
      const lines: (string | number)[][] = [];
      for (const row of scopedItems) {
        const qty = Number(row.quantity || 0);
        const price = Number(row.price || 0);
        lines.push([
          String(row.order_number ?? ""),
          String(row.shopify_created_at ?? ""),
          String(row.product ?? ""),
          String(row.variant ?? ""),
          String(row.sku ?? ""),
          qty,
          price,
          qty * price,
          String(row.currency_code ?? currency),
        ]);
      }
      return {
        columns: ["Order", "Order date", "Product", "Variant", "SKU", "Qty", "Unit price", "Line revenue", "Currency"],
        rows: lines,
      };
    }

    case "top_products": {
      if (!viewerUserId) throw new Error("Missing viewer context for top products.");
      const scopedItems = await paginateScopedOrderItemsInRange(viewerUserId, fromIso!, toIso!);
      const agg = new Map<string, { units: number; revenue: number }>();
      for (const row of scopedItems) {
        const name = [String(row.product || "Item"), String(row.variant || "")].filter(Boolean).join(" — ");
        const qty = Number(row.quantity || 0);
        const rev = qty * Number(row.price || 0);
        const prev = agg.get(name) || { units: 0, revenue: 0 };
        prev.units += qty;
        prev.revenue += rev;
        agg.set(name, prev);
      }
      const sorted = [...agg.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
      return {
        columns: ["Product", "Units sold", "Revenue"],
        rows: sorted.map(([name, v]) => [name, v.units, Number(v.revenue.toFixed(2))]),
      };
    }

    case "top_customers": {
      if (!viewerUserId) throw new Error("Missing viewer context for top customers.");
      const orders = await paginateScopedOrdersInRange(viewerUserId, fromIso!, toIso!);
      type Entry = { label: string; email: string; revenue: number; orders: number };
      const agg = new Map<string, Entry>();
      for (const o of orders) {
        const r = o as {
          customer_name?: string | null;
          email?: string | null;
          total?: number | null;
          customer_id?: string | null;
        };
        const key = r.customer_id
          ? `id:${r.customer_id}`
          : r.email
            ? `em:${String(r.email).toLowerCase()}`
            : r.customer_name
              ? `nm:${r.customer_name}`
              : "guest:no-detail";
        const label = String(r.customer_name?.trim() || r.email || "Guest");
        const email = String(r.email || "");
        const prev = agg.get(key);
        const add = Number(r.total || 0);
        if (prev) {
          prev.revenue += add;
          prev.orders += 1;
          if (!prev.email && email) prev.email = email;
        } else {
          agg.set(key, { label, email, revenue: add, orders: 1 });
        }
      }
      const rowsArr = [...agg.values()]
        .map((v) => [v.label, v.email, v.orders, Number(v.revenue.toFixed(2))] as (string | number)[])
        .sort((a, b) => Number(b[3]) - Number(a[3]));
      return {
        columns: ["Customer", "Email", "Orders", "Revenue"],
        rows: rowsArr,
      };
    }

    case "payment_status": {
      if (!viewerUserId) throw new Error("Missing viewer context for payment status report.");
      const orders = await paginateScopedOrdersInRange(viewerUserId, fromIso!, toIso!);
      const agg = new Map<string, { count: number; revenue: number }>();
      for (const o of orders) {
        const r = o as { financial_status?: string | null; total?: number | null };
        const k = String(r.financial_status || "unknown");
        const p = agg.get(k) || { count: 0, revenue: 0 };
        p.count += 1;
        p.revenue += Number(r.total || 0);
        agg.set(k, p);
      }
      const sorted = [...agg.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
      return {
        columns: ["Payment status", "Orders", "Revenue"],
        rows: sorted.map(([k, v]) => [k, v.count, Number(v.revenue.toFixed(2))]),
      };
    }

    case "fulfillment_status": {
      if (!viewerUserId) throw new Error("Missing viewer context for fulfillment status report.");
      const orders = await paginateScopedOrdersInRange(viewerUserId, fromIso!, toIso!);
      const agg = new Map<string, { count: number; revenue: number }>();
      for (const o of orders) {
        const r = o as { fulfillment_status?: string | null; total?: number | null };
        const k = String(r.fulfillment_status || "unknown");
        const p = agg.get(k) || { count: 0, revenue: 0 };
        p.count += 1;
        p.revenue += Number(r.total || 0);
        agg.set(k, p);
      }
      const sorted = [...agg.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
      return {
        columns: ["Fulfillment", "Orders", "Revenue"],
        rows: sorted.map(([k, v]) => [k, v.count, Number(v.revenue.toFixed(2))]),
      };
    }

    case "tax_summary": {
      if (!viewerUserId) throw new Error("Missing viewer context for tax summary report.");
      const orders = await paginateScopedOrdersInRange(viewerUserId, fromIso!, toIso!);
      let subtotal = 0;
      let tax = 0;
      let total = 0;
      const byCur = new Map<string, { sub: number; tx: number; tot: number }>();
      for (const o of orders) {
        const r = o as { subtotal?: number | null; total_tax?: number | null; total?: number | null; currency_code?: string | null };
        const s = Number(r.subtotal || 0);
        const t = Number(r.total_tax || 0);
        const tot = Number(r.total || 0);
        subtotal += s;
        tax += t;
        total += tot;
        const c = String(r.currency_code || currency);
        const p = byCur.get(c) || { sub: 0, tx: 0, tot: 0 };
        p.sub += s;
        p.tx += t;
        p.tot += tot;
        byCur.set(c, p);
      }
      const rows: (string | number)[][] = [
        ["All currencies combined", "—", subtotal.toFixed(2), tax.toFixed(2), total.toFixed(2)],
      ];
      for (const [c, v] of byCur) {
        rows.push([`Currency: ${c}`, c, v.sub.toFixed(2), v.tx.toFixed(2), v.tot.toFixed(2)]);
      }
      return {
        columns: ["Breakdown", "Currency code", "Subtotal", "Tax", "Total"],
        rows,
      };
    }

    case "sales_by_salesperson": {
      if (!viewerUserId) throw new Error("Missing viewer context for sales by salesperson report.");
      const orders = await paginateScopedOrdersInRange(viewerUserId, fromIso!, toIso!);
      const customerIdByShopifyCustomerId = new Map<string, string>();
      const allCustomers = await paginateScopedCustomers(viewerUserId, null, null);
      for (const c of allCustomers ?? []) {
        const row = c as { id: string; shopify_customer_id?: string | null };
        if (row.shopify_customer_id) customerIdByShopifyCustomerId.set(row.shopify_customer_id, row.id);
      }

      const customerIds = new Set<string>();
      for (const order of orders) {
        const r = order as { customer_id?: string | null; shopify_customer_id?: string | null };
        if (r.customer_id) customerIds.add(r.customer_id);
        else if (r.shopify_customer_id) {
          const mapped = customerIdByShopifyCustomerId.get(r.shopify_customer_id);
          if (mapped) customerIds.add(mapped);
        }
      }

      const salespeopleByCustomer = new Map<string, string[]>();
      for (const part of chunk([...customerIds], 200)) {
        if (!part.length) continue;
        const { data, error } = await (supabase as any)
          .from("v_salesperson_customer_attribution")
          .select("customer_id, salesperson_name")
          .in("customer_id", part);
        if (error) throw error;
        for (const row of data ?? []) {
          const customerId = String((row as { customer_id: string }).customer_id);
          const salespersonName = String((row as { salesperson_name: string }).salesperson_name || "Unknown");
          const list = salespeopleByCustomer.get(customerId) || [];
          list.push(salespersonName);
          salespeopleByCustomer.set(customerId, list);
        }
      }

      const agg = new Map<string, { orders: number; revenue: number }>();
      for (const order of orders) {
        const r = order as { customer_id?: string | null; shopify_customer_id?: string | null; total?: number | null };
        const customerId = r.customer_id || (r.shopify_customer_id ? customerIdByShopifyCustomerId.get(r.shopify_customer_id) : undefined);
        const names = customerId ? salespeopleByCustomer.get(customerId) : undefined;
        const attributed = names?.length ? names : ["Unassigned"];
        for (const name of attributed) {
          const prev = agg.get(name) || { orders: 0, revenue: 0 };
          prev.orders += 1;
          prev.revenue += Number(r.total || 0);
          agg.set(name, prev);
        }
      }

      const sorted = [...agg.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
      return {
        columns: ["Salesperson", "Orders", "Revenue"],
        rows: sorted.map(([k, v]) => [k, v.orders, Number(v.revenue.toFixed(2))]),
      };
    }

    case "inventory_snapshot": {
      const all: (string | number)[][] = [];
      let offset = 0;
      while (true) {
        const { data, error } = await supabase
          .from("shopify_variants")
          .select("sku, title, price, stock, inventory_location, shopify_products(title, vendor)")
          .order("stock", { ascending: true })
          .range(offset, offset + PAGE - 1);
        if (error) throw error;
        const batch = data ?? [];
        for (const v of batch) {
          const row = v as Record<string, unknown> & { shopify_products?: { title?: string; vendor?: string | null } };
          const p = row.shopify_products;
          all.push([
            String(p?.title ?? ""),
            String(row.title ?? ""),
            String(row.sku ?? ""),
            Number(row.stock ?? 0),
            Number(row.price ?? 0),
            String(p?.vendor ?? ""),
            String(row.inventory_location ?? ""),
          ]);
        }
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
      return {
        columns: ["Product", "Variant", "SKU", "Stock", "Price", "Vendor", "Location"],
        rows: all,
      };
    }

    case "low_stock": {
      const { data, error } = await supabase
        .from("shopify_variants")
        .select("sku, title, price, stock, shopify_products(title, vendor)")
        .lte("stock", lowStockThreshold)
        .order("stock", { ascending: true })
        .limit(2000);
      if (error) throw error;
      const rows = (data ?? []).map((v) => {
        const row = v as Record<string, unknown> & { shopify_products?: { title?: string; vendor?: string | null } };
        const p = row.shopify_products;
        return [
          String(p?.title ?? ""),
          String(row.title ?? ""),
          String(row.sku ?? ""),
          Number(row.stock ?? 0),
          Number(row.price ?? 0),
          String(p?.vendor ?? ""),
        ];
      });
      return {
        columns: ["Product", "Variant", "SKU", "Stock", "Price", "Vendor"],
        rows,
      };
    }

    case "customer_directory": {
      if (!viewerUserId) throw new Error("Missing viewer context for customer directory.");
      const all: (string | number)[][] = [];
      const customers = await paginateScopedCustomers(viewerUserId, null, null);
      for (const c of customers) {
        const r = c as Record<string, unknown>;
        all.push([
          String(r.name ?? ""),
          String(r.email ?? ""),
          String(r.city ?? ""),
          Number(r.total_orders || 0),
          Number(r.total_revenue || 0),
          String(r.spend_currency ?? currency),
          String(r.sp_assigned ?? ""),
          String(r.shopify_created_at ?? ""),
        ]);
      }
      return {
        columns: ["Name", "Email", "City", "Orders", "Revenue", "Currency", "SP assigned", "Created"],
        rows: all,
      };
    }

    case "manager_performance":
    case "supervisor_performance":
    case "team_performance": {
      if (!fromIso || !toIso) throw new Error("Select a date range for this report.");
      let query = (supabase as any)
        .from("v_user_scope_performance")
        .select("viewer_user_id, viewer_role, team_member_count");

      // Push role filtering to SQL to avoid heavy full-view scans.
      if (reportId === "manager_performance") {
        query = query.eq("viewer_role", "manager");
      } else if (reportId === "supervisor_performance") {
        query = query.eq("viewer_role", "supervisor");
      }

      const { data, error } = await query.order("team_revenue", { ascending: false });
      if (error) throw error;

      const rows = (data ?? []) as Record<string, unknown>[];
      const viewerIds = Array.from(
        new Set(rows.map((row) => String(row.viewer_user_id ?? "")).filter(Boolean)),
      );
      const [nameByUserId, scopedMetricsByViewer] = await Promise.all([
        getUserNameMap(viewerUserId, viewerIds),
        Promise.all(
          rows.map(async (row) => {
            const viewerId = String(row.viewer_user_id ?? "");
            if (!viewerId) {
              return { viewerId, metrics: { customers_count: 0, orders_count: 0, revenue: 0 } };
            }
            const { data: metricData, error: metricError } = await supabase.rpc("get_scope_order_metrics", {
              _viewer_user_id: viewerId,
              _from_iso: fromIso,
              _to_iso: toIso,
            });
            if (metricError) throw metricError;
            const metricRow = (metricData?.[0] ?? {}) as {
              customers_count?: number;
              orders_count?: number;
              revenue?: number;
            };
            return {
              viewerId,
              metrics: {
                customers_count: Number(metricRow.customers_count ?? 0),
                orders_count: Number(metricRow.orders_count ?? 0),
                revenue: Number(metricRow.revenue ?? 0),
              },
            };
          }),
        ),
      ]);
      const metricsByViewer = new Map(
        scopedMetricsByViewer.map((entry) => [entry.viewerId, entry.metrics]),
      );

      return {
        columns: ["Name", "Role", "Team members", "Team customers", "Team orders", "Team revenue"],
        rows: rows.map((row) => [
          nameByUserId.get(String(row.viewer_user_id ?? "")) || String(row.viewer_user_id ?? ""),
          String(row.viewer_role ?? ""),
          Number(row.team_member_count ?? 0),
          Number(metricsByViewer.get(String(row.viewer_user_id ?? ""))?.customers_count ?? 0),
          Number(metricsByViewer.get(String(row.viewer_user_id ?? ""))?.orders_count ?? 0),
          Number(metricsByViewer.get(String(row.viewer_user_id ?? ""))?.revenue ?? 0),
        ]),
      };
    }

    default:
      throw new Error(`Unknown report: ${reportId}`);
  }
}

export function rowsToCsv(columns: string[], rows: (string | number)[][]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [columns.map(esc).join(",")];
  for (const r of rows) {
    lines.push(r.map(esc).join(","));
  }
  return lines.join("\n");
}
