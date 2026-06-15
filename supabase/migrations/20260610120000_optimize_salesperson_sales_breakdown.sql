-- Speed up salesperson scoped sales breakdown for long periods (avoid full-table scan + huge uuid[]).

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
  return_fees NUMERIC(14,2),
  taxes NUMERIC(14,2),
  total_sales_check NUMERIC(14,2),
  orders_in_scope BIGINT,
  orders_missing_reporting BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '45s'
AS $$
  WITH bounds AS (
    SELECT * FROM public.shopify_analytics_resolve_period_bounds(_from_iso, _to_iso)
  ),
  viewer_flags AS (
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
  scoped_orders AS (
    SELECT o.id
    FROM public.shopify_orders o
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
      AND coalesce(o.test_order, false) = false
    UNION
    SELECT o.id
    FROM scoped_customers sc
    INNER JOIN public.shopify_orders o
      ON (
        o.customer_id = sc.customer_id
        OR (
          o.customer_id IS NULL
          AND o.shopify_customer_id IS NOT NULL
          AND sc.shopify_customer_id IS NOT NULL
          AND o.shopify_customer_id = sc.shopify_customer_id
        )
      )
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND coalesce(o.test_order, false) = false
  ),
  in_period_order_ids AS (
    SELECT so.id
    FROM scoped_orders so
    INNER JOIN public.shopify_orders o ON o.id = so.id
    CROSS JOIN bounds b
    WHERE public.shopify_order_reporting_day_in_period(o.shopify_created_at, b.from_iso, b.to_iso)
  ),
  lines AS (
    SELECT
      o.id AS o_id,
      public.normalize_financial_status(o.financial_status) AS st,
      coalesce(
        f.gross_sales,
        public.shopify_order_analytics_gross(o.subtotal, o.reporting_line_items_gross)
      ) AS line_gross_raw,
      coalesce(
        f.discounts,
        public.shopify_order_analytics_discount(
          o.id,
          o.subtotal,
          o.reporting_original_total_discounts,
          o.reporting_total_discounts,
          o.reporting_line_items_gross
        )
      ) AS disc_raw,
      coalesce(o.reporting_total_shipping, 0)::numeric AS ship_raw,
      o.subtotal AS r_subtotal,
      o.reporting_line_items_gross AS r_gross
    FROM public.shopify_orders o
    INNER JOIN in_period_order_ids s ON s.id = o.id
    LEFT JOIN public.shopify_analytics_order_facts f
      ON f.shopify_order_id = o.shopify_order_id
     AND f.reporting_day = public.shopify_reporting_day_bucket(o.shopify_created_at)::date
  ),
  normed AS (
    SELECT
      o_id AS id,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE line_gross_raw END AS line_gross,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE disc_raw END AS disc,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE ship_raw END AS ship,
      (st <> 'voided' AND r_subtotal IS NULL AND r_gross IS NULL) AS missing_row
    FROM lines
  ),
  rolled AS (
    SELECT
      coalesce(sum(line_gross), 0)::numeric AS sum_gross,
      coalesce(sum(disc), 0)::numeric AS sum_disc,
      coalesce(sum(ship), 0)::numeric AS sum_ship,
      count(*)::bigint AS cnt,
      count(*) FILTER (WHERE missing_row)::bigint AS missing_cnt
    FROM normed
  ),
  returns_amt AS (
    SELECT public.shopify_analytics_returns_for_scope(
      (SELECT from_iso FROM bounds),
      (SELECT to_iso FROM bounds),
      ARRAY(SELECT id FROM in_period_order_ids),
      ARRAY(SELECT id FROM scoped_orders)
    ) AS amt
  ),
  return_fees_amt AS (
    SELECT public.shopify_analytics_return_fees_for_scope(
      (SELECT from_iso FROM bounds),
      (SELECT to_iso FROM bounds),
      ARRAY(SELECT id FROM scoped_orders)
    ) AS amt
  ),
  period AS (
    SELECT p.*
    FROM bounds b
    CROSS JOIN LATERAL public.shopify_analytics_store_period_rollup(b.from_iso, b.to_iso) p
  ),
  order_net AS (
    SELECT r.sum_gross - r.sum_disc - ra.amt AS net_sales
    FROM rolled r
    CROSS JOIN returns_amt ra
  ),
  order_tax AS (
    SELECT round((n.net_sales * public.shopify_analytics_vat_rate())::numeric, 2) AS amt
    FROM order_net n
  )
  SELECT
    CASE WHEN vf.is_admin THEN p.gross_sales ELSE r.sum_gross END::numeric(14,2),
    CASE WHEN vf.is_admin THEN p.discounts ELSE r.sum_disc END::numeric(14,2),
    CASE WHEN vf.is_admin THEN p.returns_refunded ELSE ra.amt END::numeric(14,2),
    CASE WHEN vf.is_admin THEN p.net_sales ELSE (r.sum_gross - r.sum_disc - ra.amt) END::numeric(14,2),
    CASE WHEN vf.is_admin THEN p.shipping_charges ELSE r.sum_ship END::numeric(14,2),
    CASE WHEN vf.is_admin THEN p.return_fees ELSE rf.amt END::numeric(14,2),
    CASE WHEN vf.is_admin THEN p.taxes ELSE t.amt END::numeric(14,2),
    CASE
      WHEN vf.is_admin THEN p.total_sales
      ELSE (
        (r.sum_gross - r.sum_disc - ra.amt) + r.sum_ship - rf.amt + t.amt
      )
    END::numeric(14,2),
    CASE WHEN vf.is_admin THEN p.orders_count ELSE r.cnt END::bigint,
    CASE
      WHEN vf.is_admin THEN greatest(0, p.days_expected - p.days_found)
      ELSE r.missing_cnt
    END::bigint
  FROM rolled r
  CROSS JOIN returns_amt ra
  CROSS JOIN return_fees_amt rf
  CROSS JOIN order_tax t
  CROSS JOIN period p
  CROSS JOIN viewer_flags vf;
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
  return_fees numeric,
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
SET statement_timeout = '45s'
AS $$
  WITH bounds AS (
    SELECT * FROM public.shopify_analytics_resolve_period_bounds(_from_iso, _to_iso)
  ),
  bd AS (
    SELECT * FROM public.get_scope_shopify_sales_breakdown(_viewer_user_id, _from_iso, _to_iso)
  ),
  fin AS (
    SELECT * FROM public.get_scope_financial_breakdown(_viewer_user_id, _from_iso, _to_iso)
  ),
  unfulfilled AS (
    SELECT count(*)::bigint AS c
    FROM public.shopify_orders o
    CROSS JOIN bounds b
    WHERE coalesce(o.test_order, false) = false
      AND o.fulfillment_status IN ('unfulfilled', 'partial', 'on_hold')
      AND public.shopify_order_reporting_day_in_period(o.shopify_created_at, b.from_iso, b.to_iso)
      AND (
        public.has_role(auth.uid(), 'admin')
        OR EXISTS (
          SELECT 1 FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, NULL) sci
          WHERE sci.customer_id = o.customer_id
        )
        OR (
          o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.shopify_customers c
            INNER JOIN public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, NULL) sci
              ON sci.customer_id = c.id
            WHERE c.shopify_customer_id = o.shopify_customer_id
          )
        )
      )
  )
  SELECT
    bd.gross_sales_line_list,
    bd.discounts,
    bd.returns_refunded,
    bd.net_sales_derived,
    bd.shipping,
    bd.return_fees,
    bd.taxes,
    bd.total_sales_check,
    bd.orders_in_scope,
    fin.orders_paid_count,
    fin.orders_pending_count,
    fin.orders_refunded_count,
    u.c,
    fin.customers_count,
    CASE
      WHEN bd.orders_in_scope > 0 THEN round((bd.total_sales_check / bd.orders_in_scope)::numeric, 2)
      ELSE 0::numeric
    END,
    bd.orders_missing_reporting
  FROM bd
  CROSS JOIN fin
  CROSS JOIN unfulfilled u;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_shopify_sales_breakdown(uuid, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_scope_shopify_analytics_dashboard(uuid, timestamptz, timestamptz) TO authenticated, service_role;
