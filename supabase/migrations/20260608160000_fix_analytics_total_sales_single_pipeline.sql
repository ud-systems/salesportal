-- Align Total sales with Shopify breakdown formula (not raw order-total sum).
-- Use effective returns in breakdown; surface Pending in dashboard order counts.

CREATE OR REPLACE FUNCTION public.get_scope_shopify_sales_breakdown(
  _viewer_user_id UUID,
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
  WITH viewer_flags AS (
    SELECT public.has_role(auth.uid(), 'admin') AS is_admin
  ),
  scope_users AS (
    SELECT unnest(coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])) AS user_id
  ),
  scope_names AS (
    SELECT DISTINCT lower(trim(ur.salesperson_name)) AS salesperson_name_norm
    FROM public.user_roles ur
    INNER JOIN scope_users su ON su.user_id = ur.user_id
    WHERE ur.salesperson_name IS NOT NULL
      AND btrim(ur.salesperson_name) <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (
        EXISTS (
          SELECT 1
          FROM public.salesperson_customer_assignments a
          INNER JOIN scope_users su ON su.user_id = a.salesperson_user_id
          WHERE a.customer_id = c.id
        )
        OR EXISTS (
          SELECT 1
          FROM scope_names sn
          WHERE sn.salesperson_name_norm = lower(trim(coalesce(c.sp_assigned, '')))
             OR sn.salesperson_name_norm = lower(trim(coalesce(c.referred_by, '')))
        )
      )
  ),
  admin_order_ids AS (
    SELECT o.id
    FROM public.shopify_orders o
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_order_ids_direct AS (
    SELECT o.id
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_order_ids_fallback AS (
    SELECT o.id
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_order_ids AS (
    SELECT DISTINCT id FROM (
      SELECT id FROM admin_order_ids
      UNION ALL
      SELECT id FROM scoped_order_ids_direct
      UNION ALL
      SELECT id FROM scoped_order_ids_fallback
    ) u
  ),
  lines AS (
    SELECT
      o.id o_id,
      public.normalize_financial_status(o.financial_status) AS st,
      coalesce(o.reporting_line_items_gross, o.subtotal, 0)::numeric AS line_gross_raw,
      coalesce(o.reporting_total_discounts, 0)::numeric AS disc_raw,
      coalesce(o.reporting_total_shipping, 0)::numeric AS ship_raw,
      public.shopify_order_effective_returns(
        o.financial_status,
        o.total,
        o.current_total,
        o.original_total,
        o.reporting_total_refunded
      )::numeric AS refunded_raw,
      coalesce(o.total_tax, 0)::numeric AS tax_raw,
      o.reporting_line_items_gross AS r_gross,
      o.reporting_total_discounts AS r_disc
    FROM public.shopify_orders o
    INNER JOIN scoped_order_ids s ON s.id = o.id
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
      o.total,
      o.current_total,
      o.original_total,
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
      o.total,
      o.current_total,
      o.original_total,
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
      total,
      current_total,
      original_total,
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
      public.shopify_order_effective_returns(
        financial_status,
        total,
        current_total,
        original_total,
        reporting_total_refunded
      )::numeric AS refunded_raw,
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

CREATE OR REPLACE FUNCTION public.get_scope_shopify_analytics_dashboard(
  _viewer_user_id uuid,
  _from_iso timestamptz DEFAULT NULL,
  _to_iso timestamptz DEFAULT NULL
)
RETURNS TABLE (
  gross_sales numeric,
  discounts numeric,
  returns numeric,
  net_sales numeric,
  shipping_charges numeric,
  taxes numeric,
  total_sales numeric,
  orders_total bigint,
  orders_paid bigint,
  orders_pending bigint,
  orders_refunded bigint,
  orders_unfulfilled bigint,
  customers_count bigint,
  average_order_value numeric,
  orders_missing_reporting bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bd AS (
    SELECT * FROM public.get_scope_shopify_sales_breakdown(_viewer_user_id, _from_iso, _to_iso)
  ),
  fin AS (
    SELECT * FROM public.get_scope_financial_breakdown(_viewer_user_id, _from_iso, _to_iso)
  ),
  unfulfilled AS (
    SELECT count(*)::bigint AS c
    FROM public.shopify_orders o
    WHERE coalesce(o.test_order, false) = false
      AND o.fulfillment_status IN ('unfulfilled', 'partial', 'on_hold')
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND (
        public.has_role(auth.uid(), 'admin')
        OR EXISTS (
          SELECT 1
          FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, NULL) sci
          WHERE sci.customer_id = o.customer_id
        )
        OR (
          o.customer_id IS NULL
          AND o.shopify_customer_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.shopify_customers c
            INNER JOIN public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, NULL) sci
              ON sci.customer_id = c.id
            WHERE c.shopify_customer_id = o.shopify_customer_id
          )
        )
      )
  )
  SELECT
    bd.gross_sales_line_list AS gross_sales,
    bd.discounts,
    bd.returns_refunded AS returns,
    bd.net_sales_derived AS net_sales,
    bd.shipping AS shipping_charges,
    bd.taxes,
    bd.total_sales_check AS total_sales,
    fin.orders_total_count AS orders_total,
    fin.orders_paid_count AS orders_paid,
    fin.orders_pending_count AS orders_pending,
    fin.orders_refunded_count AS orders_refunded,
    u.c AS orders_unfulfilled,
    fin.customers_count,
    CASE
      WHEN fin.orders_total_count > 0 THEN round((bd.total_sales_check / fin.orders_total_count)::numeric, 2)
      ELSE 0::numeric
    END AS average_order_value,
    bd.orders_missing_reporting
  FROM bd
  CROSS JOIN fin
  CROSS JOIN unfulfilled u;
$$;

CREATE OR REPLACE FUNCTION public.get_selected_salespeople_shopify_analytics_dashboard(
  _viewer_user_id uuid,
  _salesperson_user_ids uuid[],
  _from_iso timestamptz DEFAULT NULL,
  _to_iso timestamptz DEFAULT NULL
)
RETURNS TABLE (
  gross_sales numeric,
  discounts numeric,
  returns numeric,
  net_sales numeric,
  shipping_charges numeric,
  taxes numeric,
  total_sales numeric,
  orders_total bigint,
  orders_paid bigint,
  orders_pending bigint,
  orders_refunded bigint,
  orders_unfulfilled bigint,
  customers_count bigint,
  average_order_value numeric,
  orders_missing_reporting bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH bd AS (
    SELECT * FROM public.get_selected_salespeople_shopify_sales_breakdown(
      _viewer_user_id, _salesperson_user_ids, _from_iso, _to_iso
    )
  ),
  fin AS (
    SELECT
      t.orders_total_count,
      t.orders_paid_count,
      t.orders_pending_count,
      t.orders_refunded_count,
      t.customers_count,
      t.current_gross_sales
    FROM public.get_selected_salespeople_scope_metrics_timeseries(
      _viewer_user_id, _salesperson_user_ids, _from_iso, _to_iso, 'day'
    ) t
  ),
  unfulfilled AS (
    SELECT count(DISTINCT o.id)::bigint AS c
    FROM public.shopify_orders o
    INNER JOIN public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids) sci
      ON sci.customer_id = o.customer_id
    WHERE coalesce(o.test_order, false) = false
      AND o.fulfillment_status IN ('unfulfilled', 'partial', 'on_hold')
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
  )
  SELECT
    bd.gross_sales_line_list AS gross_sales,
    bd.discounts,
    bd.returns_refunded AS returns,
    bd.net_sales_derived AS net_sales,
    bd.shipping AS shipping_charges,
    bd.taxes,
    bd.total_sales_check AS total_sales,
    fin.orders_total_count AS orders_total,
    fin.orders_paid_count AS orders_paid,
    fin.orders_pending_count AS orders_pending,
    fin.orders_refunded_count AS orders_refunded,
    u.c AS orders_unfulfilled,
    fin.customers_count,
    CASE
      WHEN fin.orders_total_count > 0 THEN round((bd.total_sales_check / fin.orders_total_count)::numeric, 2)
      ELSE 0::numeric
    END AS average_order_value,
    bd.orders_missing_reporting
  FROM bd
  CROSS JOIN fin
  CROSS JOIN unfulfilled u;
$$;
