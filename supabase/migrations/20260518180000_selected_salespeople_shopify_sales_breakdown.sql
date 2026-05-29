-- Layer 2 scoped to explicit salesperson user IDs (same customer/order universe as
-- get_selected_salespeople_scope_metrics_timeseries). Plus multi-viewer sum helper
-- aligned with get_scope_financial_breakdown_for_viewers.

CREATE OR REPLACE FUNCTION public.get_selected_salespeople_shopify_sales_breakdown(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  gross_sales_line_list NUMERIC(14,2),
  discounts NUMERIC(14,2),
  returns_refunded NUMERIC(14,2),
  net_sales_derived NUMERIC(14,2),
  shipping NUMERIC(14,2),
  taxes NUMERIC(14,2),
  total_sales_check NUMERIC(14,2),
  orders_in_scope BIGINT,
  orders_missing_reporting BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped_customer_ids AS (
    SELECT customer_id
    FROM public.get_scoped_customer_ids_for_salespeople(
      _viewer_user_id,
      _salesperson_user_ids
    )
  ),
  scoped_customers AS (
    SELECT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.shopify_customers c
    INNER JOIN scoped_customer_ids sci ON sci.customer_id = c.id
  ),
  order_rows AS (
    SELECT
      o.id,
      o.financial_status,
      o.reporting_line_items_gross,
      o.reporting_total_discounts,
      o.reporting_total_shipping,
      o.reporting_total_refunded,
      o.subtotal,
      o.total_tax
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) <= _to_iso)

    UNION ALL

    SELECT
      o.id,
      o.financial_status,
      o.reporting_line_items_gross,
      o.reporting_total_discounts,
      o.reporting_total_shipping,
      o.reporting_total_refunded,
      o.subtotal,
      o.total_tax
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) <= _to_iso)
  ),
  scoped_orders AS (
    SELECT DISTINCT ON (id)
      id,
      financial_status,
      reporting_line_items_gross,
      reporting_total_discounts,
      reporting_total_shipping,
      reporting_total_refunded,
      subtotal,
      total_tax
    FROM order_rows
    ORDER BY id
  ),
  lines AS (
    SELECT
      id AS o_id,
      public.normalize_financial_status(financial_status) AS st,
      coalesce(reporting_line_items_gross, subtotal, 0)::numeric AS line_gross_raw,
      coalesce(reporting_total_discounts, 0)::numeric AS disc_raw,
      coalesce(reporting_total_shipping, 0)::numeric AS ship_raw,
      coalesce(reporting_total_refunded, 0)::numeric AS refunded_raw,
      coalesce(total_tax, 0)::numeric AS tax_raw,
      reporting_line_items_gross AS r_gross,
      reporting_total_discounts AS r_disc
    FROM scoped_orders
  ),
  normed AS (
    SELECT
      o_id AS id,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE line_gross_raw END AS line_gross,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE disc_raw END AS disc,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE refunded_raw END AS refunded,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE ship_raw END AS ship,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE tax_raw END AS tax_amt,
      (st <> 'voided' AND r_gross IS NULL) AS missing_row
    FROM lines
  )
  SELECT
    coalesce(sum(line_gross), 0)::numeric(14,2) AS gross_sales_line_list,
    coalesce(sum(disc), 0)::numeric(14,2) AS discounts,
    coalesce(sum(refunded), 0)::numeric(14,2) AS returns_refunded,
    (coalesce(sum(line_gross), 0) - coalesce(sum(disc), 0) - coalesce(sum(refunded), 0))::numeric(14,2) AS net_sales_derived,
    coalesce(sum(ship), 0)::numeric(14,2) AS shipping,
    coalesce(sum(tax_amt), 0)::numeric(14,2) AS taxes,
    (
      coalesce(sum(line_gross), 0) - coalesce(sum(disc), 0) - coalesce(sum(refunded), 0)
      + coalesce(sum(tax_amt), 0) + coalesce(sum(ship), 0)
    )::numeric(14,2) AS total_sales_check,
    count(*)::bigint AS orders_in_scope,
    count(*) FILTER (WHERE missing_row)::bigint AS orders_missing_reporting
  FROM normed;
$$;

COMMENT ON FUNCTION public.get_selected_salespeople_shopify_sales_breakdown(uuid, uuid[], timestamptz, timestamptz) IS
  'Layer 2 for customers assigned to the given salesperson user IDs (viewer-authorized). Order dates use coalesce(shopify_created_at, created_at) like get_selected_salespeople_scope_metrics_timeseries.';

GRANT EXECUTE ON FUNCTION public.get_selected_salespeople_shopify_sales_breakdown(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.get_scope_shopify_sales_breakdown_for_viewers(
  _viewer_user_ids UUID[],
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  gross_sales_line_list NUMERIC(14,2),
  discounts NUMERIC(14,2),
  returns_refunded NUMERIC(14,2),
  net_sales_derived NUMERIC(14,2),
  shipping NUMERIC(14,2),
  taxes NUMERIC(14,2),
  total_sales_check NUMERIC(14,2),
  orders_in_scope BIGINT,
  orders_missing_reporting BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH input_viewers AS (
    SELECT DISTINCT unnest(coalesce(_viewer_user_ids, ARRAY[]::uuid[])) AS viewer_user_id
  ),
  scoped AS (
    SELECT
      coalesce(sum(m.gross_sales_line_list), 0)::numeric(14,2) AS gross_sales_line_list,
      coalesce(sum(m.discounts), 0)::numeric(14,2) AS discounts,
      coalesce(sum(m.returns_refunded), 0)::numeric(14,2) AS returns_refunded,
      coalesce(sum(m.net_sales_derived), 0)::numeric(14,2) AS net_sales_derived,
      coalesce(sum(m.shipping), 0)::numeric(14,2) AS shipping,
      coalesce(sum(m.taxes), 0)::numeric(14,2) AS taxes,
      coalesce(sum(m.total_sales_check), 0)::numeric(14,2) AS total_sales_check,
      coalesce(sum(m.orders_in_scope), 0)::bigint AS orders_in_scope,
      coalesce(sum(m.orders_missing_reporting), 0)::bigint AS orders_missing_reporting
    FROM input_viewers iv
    LEFT JOIN LATERAL public.get_scope_shopify_sales_breakdown(
      iv.viewer_user_id,
      _from_iso,
      _to_iso
    ) m ON true
  )
  SELECT * FROM scoped;
$$;

COMMENT ON FUNCTION public.get_scope_shopify_sales_breakdown_for_viewers(uuid[], timestamptz, timestamptz) IS
  'Sums get_scope_shopify_sales_breakdown per viewer UUID (same aggregation pattern as get_scope_financial_breakdown_for_viewers).';

GRANT EXECUTE ON FUNCTION public.get_scope_shopify_sales_breakdown_for_viewers(UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
TO authenticated, service_role;
