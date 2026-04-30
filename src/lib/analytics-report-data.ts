import { supabase } from "@/integrations/supabase/client";

export type ReportFetchParams = {
  fromIso: string | null;
  toIso: string | null;
  currency: string;
  viewerUserId?: string;
  lowStockThreshold?: number;
  maxRows?: number;
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

// Lower page size to reduce per-call payload and timeout risk on heavy scoped report pulls.
const PAGE = 200;

function asReportError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const message = [e.message, e.details, e.hint, e.code]
      .filter((v) => typeof v === "string" && v.trim().length > 0)
      .join(" | ");
    if (message) return new Error(message);
  }
  return new Error("Report query failed");
}

async function paginateScopedOrdersInRange(
  viewerUserId: string,
  fromIso: string,
  toIso: string,
  maxRows?: number,
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
      _customer_ids: null,
    });
    if (error) throw asReportError(error);
    const rows = (data ?? []) as { row_data?: Record<string, unknown> | null; total_count?: number | null }[];
    const batch = rows.map((r) => r.row_data).filter((r): r is Record<string, unknown> => Boolean(r));
    all.push(...batch);
    if (typeof maxRows === "number" && maxRows > 0 && all.length >= maxRows) {
      return all.slice(0, maxRows);
    }
    if (batch.length < PAGE) break;
    page += 1;
  }
  return all;
}

async function paginateScopedCustomers(
  viewerUserId: string,
  fromIso: string | null,
  toIso: string | null,
  maxRows?: number,
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
      _customer_ids: null,
    });
    if (error) throw asReportError(error);
    const rows = (data ?? []) as { row_data?: Record<string, unknown> | null; total_count?: number | null }[];
    const batch = rows.map((r) => r.row_data).filter((r): r is Record<string, unknown> => Boolean(r));
    all.push(...batch);
    if (typeof maxRows === "number" && maxRows > 0 && all.length >= maxRows) {
      return all.slice(0, maxRows);
    }
    if (batch.length < PAGE) break;
    page += 1;
  }
  return all;
}

async function paginateScopedOrderItemsInRange(
  viewerUserId: string,
  fromIso: string,
  toIso: string,
  maxRows?: number,
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
    if (error) throw asReportError(error);
    const rows = (data ?? []) as { row_data?: Record<string, unknown> | null; total_count?: number | null }[];
    const batch = rows.map((r) => r.row_data).filter((r): r is Record<string, unknown> => Boolean(r));
    all.push(...batch);
    if (typeof maxRows === "number" && maxRows > 0 && all.length >= maxRows) {
      return all.slice(0, maxRows);
    }
    if (batch.length < PAGE) break;
    page += 1;
  }
  return all;
}

export async function fetchReportData(
  reportId: string,
  params: ReportFetchParams,
): Promise<{ columns: string[]; rows: (string | number)[][] }> {
  const { fromIso, toIso, currency, viewerUserId, lowStockThreshold = 10, maxRows } = params;

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
      if (error) throw asReportError(error);
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
      const orders = await paginateScopedOrdersInRange(viewerUserId, fromIso!, toIso!, maxRows);
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
      const scopedItems = await paginateScopedOrderItemsInRange(viewerUserId, fromIso!, toIso!, maxRows);
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
      const { data, error } = await (supabase as any).rpc("get_analytics_top_products", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso!,
        _to_iso: toIso!,
      });
      if (error) throw asReportError(error);
      const rows = (data ?? []) as Array<{ product_name?: string | null; units_sold?: number | null; revenue?: number | null }>;
      return {
        columns: ["Product", "Units sold", "Revenue"],
        rows: rows.map((row) => [
          String(row.product_name ?? "Item"),
          Number(row.units_sold ?? 0),
          Number(row.revenue ?? 0),
        ]),
      };
    }

    case "top_customers": {
      if (!viewerUserId) throw new Error("Missing viewer context for top customers.");
      const { data, error } = await (supabase as any).rpc("get_analytics_top_customers", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso!,
        _to_iso: toIso!,
      });
      if (error) throw asReportError(error);
      const rows = (data ?? []) as Array<{
        customer_label?: string | null;
        customer_email?: string | null;
        orders_count?: number | null;
        revenue?: number | null;
      }>;
      return {
        columns: ["Customer", "Email", "Orders", "Revenue"],
        rows: rows.map((row) => [
          String(row.customer_label ?? "Guest"),
          String(row.customer_email ?? ""),
          Number(row.orders_count ?? 0),
          Number(row.revenue ?? 0),
        ]),
      };
    }

    case "payment_status": {
      if (!viewerUserId) throw new Error("Missing viewer context for payment status report.");
      const { data, error } = await (supabase as any).rpc("get_analytics_payment_status_breakdown", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso!,
        _to_iso: toIso!,
      });
      if (error) throw asReportError(error);
      const rows = (data ?? []) as Array<{ payment_status?: string | null; orders_count?: number | null; revenue?: number | null }>;
      return {
        columns: ["Payment status", "Orders", "Revenue"],
        rows: rows.map((row) => [
          String(row.payment_status ?? "unknown"),
          Number(row.orders_count ?? 0),
          Number(row.revenue ?? 0),
        ]),
      };
    }

    case "fulfillment_status": {
      if (!viewerUserId) throw new Error("Missing viewer context for fulfillment status report.");
      const { data, error } = await (supabase as any).rpc("get_analytics_fulfillment_status_breakdown", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso!,
        _to_iso: toIso!,
      });
      if (error) throw asReportError(error);
      const rows = (data ?? []) as Array<{
        fulfillment_status?: string | null;
        orders_count?: number | null;
        revenue?: number | null;
      }>;
      return {
        columns: ["Fulfillment", "Orders", "Revenue"],
        rows: rows.map((row) => [
          String(row.fulfillment_status ?? "unknown"),
          Number(row.orders_count ?? 0),
          Number(row.revenue ?? 0),
        ]),
      };
    }

    case "tax_summary": {
      if (!viewerUserId) throw new Error("Missing viewer context for tax summary report.");
      const { data, error } = await (supabase as any).rpc("get_analytics_tax_summary_rows", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso!,
        _to_iso: toIso!,
      });
      if (error) throw asReportError(error);
      const rows = (data ?? []) as Array<{
        breakdown?: string | null;
        currency_code?: string | null;
        subtotal?: number | null;
        tax?: number | null;
        total?: number | null;
      }>;
      return {
        columns: ["Breakdown", "Currency code", "Subtotal", "Tax", "Total"],
        rows: rows.map((row) => [
          String(row.breakdown ?? ""),
          String(row.currency_code ?? currency),
          Number(row.subtotal ?? 0),
          Number(row.tax ?? 0),
          Number(row.total ?? 0),
        ]),
      };
    }

    case "sales_by_salesperson": {
      if (!viewerUserId) throw new Error("Missing viewer context for sales by salesperson report.");
      const { data, error } = await (supabase as any).rpc("get_analytics_sales_by_salesperson", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso!,
        _to_iso: toIso!,
      });
      if (error) throw asReportError(error);
      const rows = (data ?? []) as Array<{ salesperson_name?: string | null; orders_count?: number | null; revenue?: number | null }>;
      return {
        columns: ["Salesperson", "Orders", "Revenue"],
        rows: rows.map((row) => [
          String(row.salesperson_name ?? "Unassigned"),
          Number(row.orders_count ?? 0),
          Number(row.revenue ?? 0),
        ]),
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
        if (error) throw asReportError(error);
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
      if (error) throw asReportError(error);
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
      const customers = await paginateScopedCustomers(viewerUserId, null, null, maxRows);
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
      if (!viewerUserId) throw new Error("Missing viewer context for team performance report.");
      const roleFilter =
        reportId === "manager_performance"
          ? "manager"
          : reportId === "supervisor_performance"
            ? "supervisor"
            : "all";
      const { data, error } = await (supabase as any).rpc("get_analytics_scope_performance_rows", {
        _viewer_user_id: viewerUserId,
        _from_iso: fromIso,
        _to_iso: toIso,
        _role_filter: roleFilter,
      });
      if (error) throw asReportError(error);
      const rows = (data ?? []) as Array<{
        viewer_name?: string | null;
        viewer_role?: string | null;
        team_member_count?: number | null;
        team_customers_count?: number | null;
        team_orders_count?: number | null;
        team_revenue?: number | null;
      }>;
      return {
        columns: ["Name", "Role", "Team members", "Team customers", "Team orders", "Team revenue"],
        rows: rows.map((row) => [
          String(row.viewer_name ?? ""),
          String(row.viewer_role ?? ""),
          Number(row.team_member_count ?? 0),
          Number(row.team_customers_count ?? 0),
          Number(row.team_orders_count ?? 0),
          Number(row.team_revenue ?? 0),
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
