-- Revert 20260609180000 + 20260609190000: restore ShopifyQL period-facts dashboard
-- (state from 20260609170000 + 20260609150000).

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
  in_period_order_ids AS (
    SELECT o.id
    FROM public.shopify_orders o
    CROSS JOIN viewer_flags vf
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
      AND (
        vf.is_admin
        OR EXISTS (
          SELECT 1 FROM scoped_customers sc
          WHERE sc.customer_id = o.customer_id
             OR (o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL AND sc.shopify_customer_id = o.shopify_customer_id)
        )
      )
  ),
  all_scoped_order_ids AS (
    SELECT o.id
    FROM public.shopify_orders o
    CROSS JOIN viewer_flags vf
    WHERE coalesce(o.test_order, false) = false
      AND (
        vf.is_admin
        OR EXISTS (
          SELECT 1 FROM scoped_customers sc
          WHERE sc.customer_id = o.customer_id
             OR (o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL AND sc.shopify_customer_id = o.shopify_customer_id)
        )
      )
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
      _from_iso, _to_iso,
      ARRAY(SELECT id FROM in_period_order_ids),
      ARRAY(SELECT id FROM all_scoped_order_ids)
    ) AS amt
  ),
  return_fees_amt AS (
    SELECT public.shopify_analytics_return_fees_for_scope(
      _from_iso, _to_iso,
      ARRAY(SELECT id FROM all_scoped_order_ids)
    ) AS amt
  ),
  period AS (
    SELECT * FROM public.shopify_analytics_store_period_rollup(_from_iso, _to_iso)
  ),
  order_net AS (
    SELECT r.sum_gross - r.sum_disc - ra.amt AS net_sales
    FROM rolled r
    CROSS JOIN returns_amt ra
  ),
  order_tax AS (
    SELECT round((n.net_sales * public.shopify_analytics_vat_rate())::numeric, 2) AS amt
    FROM order_net n
  ),
  use_period AS (
    SELECT vf.is_admin AND p.is_complete AS yes
    FROM viewer_flags vf
    CROSS JOIN period p
  )
  SELECT
    CASE WHEN up.yes THEN p.gross_sales ELSE r.sum_gross END::numeric(14,2),
    CASE WHEN up.yes THEN p.discounts ELSE r.sum_disc END::numeric(14,2),
    CASE WHEN up.yes THEN p.returns_refunded ELSE ra.amt END::numeric(14,2),
    CASE WHEN up.yes THEN p.net_sales ELSE (r.sum_gross - r.sum_disc - ra.amt) END::numeric(14,2),
    CASE WHEN up.yes THEN p.shipping_charges ELSE r.sum_ship END::numeric(14,2),
    CASE WHEN up.yes THEN p.return_fees ELSE rf.amt END::numeric(14,2),
    CASE WHEN up.yes THEN p.taxes ELSE t.amt END::numeric(14,2),
    CASE
      WHEN up.yes THEN p.total_sales
      ELSE (
        (r.sum_gross - r.sum_disc - ra.amt) + r.sum_ship - rf.amt + t.amt
      )
    END::numeric(14,2),
    CASE WHEN up.yes THEN p.orders_count ELSE r.cnt END::bigint,
    CASE WHEN up.yes THEN 0::bigint ELSE r.missing_cnt END::bigint
  FROM rolled r
  CROSS JOIN returns_amt ra
  CROSS JOIN return_fees_amt rf
  CROSS JOIN order_tax t
  CROSS JOIN period p
  CROSS JOIN use_period up;
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
AS $$
  WITH bd AS (
    SELECT * FROM public.get_scope_shopify_sales_breakdown(_viewer_user_id, _from_iso, _to_iso)
  ),
  period AS (
    SELECT * FROM public.shopify_analytics_store_period_rollup(_from_iso, _to_iso)
  ),
  use_shopifyql AS (
    SELECT public.has_role(auth.uid(), 'admin') AND p.is_complete AS yes
    FROM period p
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
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
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
    CASE WHEN us.yes THEN bd.orders_in_scope ELSE fin.orders_total_count END,
    fin.orders_paid_count,
    fin.orders_pending_count,
    fin.orders_refunded_count,
    u.c,
    fin.customers_count,
    CASE
      WHEN us.yes AND bd.orders_in_scope > 0 THEN round((bd.total_sales_check / bd.orders_in_scope)::numeric, 2)
      WHEN fin.orders_total_count > 0 THEN round((bd.total_sales_check / fin.orders_total_count)::numeric, 2)
      ELSE 0::numeric
    END,
    bd.orders_missing_reporting
  FROM bd
  CROSS JOIN fin
  CROSS JOIN unfulfilled u
  CROSS JOIN use_shopifyql us;
$$;

CREATE OR REPLACE FUNCTION public.get_scope_order_timeseries(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _bucket TEXT DEFAULT 'month'
)
RETURNS TABLE (
  bucket_key TEXT,
  bucket_label TEXT,
  orders_count BIGINT,
  revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH viewer_flags AS (
    SELECT public.has_role(auth.uid(), 'admin') AS is_admin
  ),
  period AS (
    SELECT * FROM public.shopify_analytics_store_period_rollup(_from_iso, _to_iso)
  ),
  use_facts AS (
    SELECT
      vf.is_admin
      AND p.is_complete
      AND _from_iso IS NOT NULL
      AND _to_iso IS NOT NULL AS yes
    FROM viewer_flags vf
    CROSS JOIN period p
  ),
  fact_bucketed AS (
    SELECT
      CASE
        WHEN _bucket = 'day'
          THEN to_char(f.reporting_day, 'YYYY-MM-DD')
        ELSE to_char(date_trunc('month', f.reporting_day::timestamp), 'YYYY-MM')
      END AS bucket_key,
      CASE
        WHEN _bucket = 'day'
          THEN to_char(f.reporting_day, 'DD Mon')
        ELSE to_char(date_trunc('month', f.reporting_day::timestamp), 'Mon YYYY')
      END AS bucket_label,
      sum(f.orders_count)::bigint AS orders_count,
      coalesce(sum(f.total_sales), 0)::numeric(14,2) AS revenue
    FROM public.shopify_analytics_period_facts f
    WHERE f.reporting_day IN (
      SELECT d FROM public.shopify_reporting_days_in_period(_from_iso, _to_iso) d
    )
    GROUP BY 1, 2
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
    SELECT DISTINCT
      o.id,
      o.shopify_created_at,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric
      END AS order_amount
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id = sc.customer_id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND sc.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = sc.shopify_customer_id
      )
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  order_bucketed AS (
    SELECT
      CASE
        WHEN _bucket = 'day'
          THEN to_char(public.shopify_reporting_day_bucket(o.shopify_created_at), 'YYYY-MM-DD')
        ELSE to_char(public.shopify_reporting_month_bucket(o.shopify_created_at), 'YYYY-MM')
      END AS bucket_key,
      CASE
        WHEN _bucket = 'day'
          THEN to_char(public.shopify_reporting_day_bucket(o.shopify_created_at), 'DD Mon')
        ELSE to_char(public.shopify_reporting_month_bucket(o.shopify_created_at), 'Mon YYYY')
      END AS bucket_label,
      count(*)::bigint AS orders_count,
      coalesce(sum(o.order_amount), 0)::numeric(14,2) AS revenue
    FROM scoped_orders o
    GROUP BY 1, 2
  )
  SELECT
    fb.bucket_key,
    fb.bucket_label,
    fb.orders_count,
    fb.revenue
  FROM fact_bucketed fb
  CROSS JOIN use_facts uf
  WHERE uf.yes
  UNION ALL
  SELECT
    ob.bucket_key,
    ob.bucket_label,
    ob.orders_count,
    ob.revenue
  FROM order_bucketed ob
  CROSS JOIN use_facts uf
  WHERE NOT uf.yes
  ORDER BY 1 ASC;
$$;
