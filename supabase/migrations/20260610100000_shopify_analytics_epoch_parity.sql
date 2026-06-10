-- Shopify Analytics epoch parity: 2024-11-01 Dubai floor, no order-rollup fallback for admin.
-- Rollback: re-apply 20260609200000_revert_created_at_dashboard_changes.sql (breakdown + dashboard + timeseries).

CREATE OR REPLACE FUNCTION public.shopify_analytics_epoch_day()
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '2024-11-01'::date;
$$;

CREATE OR REPLACE FUNCTION public.shopify_analytics_epoch_start_iso()
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT (public.shopify_analytics_epoch_day()::timestamp AT TIME ZONE public.shopify_reporting_timezone());
$$;

CREATE OR REPLACE FUNCTION public.shopify_analytics_today_exclusive_end_iso()
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT (
    (date_trunc('day', now() AT TIME ZONE public.shopify_reporting_timezone()) + interval '1 day')::timestamp
    AT TIME ZONE public.shopify_reporting_timezone()
  );
$$;

CREATE OR REPLACE FUNCTION public.shopify_analytics_resolve_period_bounds(
  _from_iso timestamptz,
  _to_iso timestamptz
)
RETURNS TABLE (
  from_iso timestamptz,
  to_iso timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    coalesce(_from_iso, public.shopify_analytics_epoch_start_iso()),
    coalesce(_to_iso, public.shopify_analytics_today_exclusive_end_iso());
$$;

CREATE OR REPLACE FUNCTION public.shopify_order_reporting_day_in_period(
  _order_ts timestamptz,
  _from_iso timestamptz,
  _to_iso timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  WITH b AS (
    SELECT * FROM public.shopify_analytics_resolve_period_bounds(_from_iso, _to_iso)
  )
  SELECT public.shopify_reporting_day_bucket(_order_ts)::date IN (
    SELECT d
    FROM b
    CROSS JOIN LATERAL public.shopify_reporting_days_in_period(b.from_iso, b.to_iso) d
  );
$$;

GRANT EXECUTE ON FUNCTION public.shopify_analytics_epoch_day() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_analytics_epoch_start_iso() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_analytics_today_exclusive_end_iso() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_analytics_resolve_period_bounds(timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_order_reporting_day_in_period(timestamptz, timestamptz, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.shopify_analytics_store_period_rollup(
  _from_iso timestamptz,
  _to_iso timestamptz
)
RETURNS TABLE (
  gross_sales numeric,
  discounts numeric,
  returns_refunded numeric,
  net_sales numeric,
  shipping_charges numeric,
  return_fees numeric,
  taxes numeric,
  total_sales numeric,
  orders_count bigint,
  days_expected bigint,
  days_found bigint,
  is_complete boolean
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT * FROM public.shopify_analytics_resolve_period_bounds(_from_iso, _to_iso)
  ),
  expected AS (
    SELECT count(*)::bigint AS cnt
    FROM bounds b
    CROSS JOIN LATERAL public.shopify_reporting_days_in_period(b.from_iso, b.to_iso) d
  ),
  matched AS (
    SELECT
      coalesce(sum(f.gross_sales), 0)::numeric AS gross_sales,
      coalesce(sum(f.discounts), 0)::numeric AS discounts,
      coalesce(sum(f.returns_refunded), 0)::numeric AS returns_refunded,
      coalesce(sum(f.net_sales), 0)::numeric AS net_sales,
      coalesce(sum(f.shipping_charges), 0)::numeric AS shipping_charges,
      coalesce(sum(f.return_fees), 0)::numeric AS return_fees,
      coalesce(sum(f.taxes), 0)::numeric AS taxes,
      coalesce(sum(f.total_sales), 0)::numeric AS total_sales,
      coalesce(sum(f.orders_count), 0)::bigint AS orders_count,
      count(*)::bigint AS cnt
    FROM bounds b
    INNER JOIN public.shopify_analytics_period_facts f
      ON f.reporting_day IN (
        SELECT d FROM public.shopify_reporting_days_in_period(b.from_iso, b.to_iso) d
      )
  )
  SELECT
    m.gross_sales,
    m.discounts,
    m.returns_refunded,
    m.net_sales,
    m.shipping_charges,
    m.return_fees,
    m.taxes,
    m.total_sales,
    m.orders_count,
    e.cnt AS days_expected,
    m.cnt AS days_found,
    (e.cnt > 0 AND m.cnt = e.cnt) AS is_complete
  FROM expected e
  CROSS JOIN matched m;
$$;

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
  in_period_order_ids AS (
    SELECT o.id
    FROM public.shopify_orders o
    CROSS JOIN viewer_flags vf
  CROSS JOIN bounds b
    WHERE coalesce(o.test_order, false) = false
      AND public.shopify_order_reporting_day_in_period(o.shopify_created_at, b.from_iso, b.to_iso)
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
      (SELECT from_iso FROM bounds),
      (SELECT to_iso FROM bounds),
      ARRAY(SELECT id FROM in_period_order_ids),
      ARRAY(SELECT id FROM all_scoped_order_ids)
    ) AS amt
  ),
  return_fees_amt AS (
    SELECT public.shopify_analytics_return_fees_for_scope(
      (SELECT from_iso FROM bounds),
      (SELECT to_iso FROM bounds),
      ARRAY(SELECT id FROM all_scoped_order_ids)
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
  WITH bounds AS (
    SELECT * FROM public.shopify_analytics_resolve_period_bounds(_from_iso, _to_iso)
  ),
  scoped_customer_ids AS (
    SELECT customer_id
    FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids)
  ),
  scoped_customers AS (
    SELECT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    INNER JOIN scoped_customer_ids sci ON sci.customer_id = c.id
  ),
  in_period_order_ids AS (
    SELECT o.id
    FROM public.shopify_orders o
    CROSS JOIN bounds b
    INNER JOIN scoped_customers sc
      ON o.customer_id = sc.customer_id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND sc.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = sc.shopify_customer_id
      )
    WHERE coalesce(o.test_order, false) = false
      AND public.shopify_order_reporting_day_in_period(o.shopify_created_at, b.from_iso, b.to_iso)
  ),
  all_scoped_order_ids AS (
    SELECT o.id
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id = sc.customer_id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND sc.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = sc.shopify_customer_id
      )
    WHERE coalesce(o.test_order, false) = false
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
      ARRAY(SELECT id FROM all_scoped_order_ids)
    ) AS amt
  ),
  return_fees_amt AS (
    SELECT public.shopify_analytics_return_fees_for_scope(
      (SELECT from_iso FROM bounds),
      (SELECT to_iso FROM bounds),
      ARRAY(SELECT id FROM all_scoped_order_ids)
    ) AS amt
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
    r.sum_gross::numeric(14,2),
    r.sum_disc::numeric(14,2),
    ra.amt::numeric(14,2),
    (r.sum_gross - r.sum_disc - ra.amt)::numeric(14,2),
    r.sum_ship::numeric(14,2),
    rf.amt::numeric(14,2),
    t.amt::numeric(14,2),
    ((r.sum_gross - r.sum_disc - ra.amt) + r.sum_ship - rf.amt + t.amt)::numeric(14,2),
    r.cnt,
    r.missing_cnt
  FROM rolled r
  CROSS JOIN returns_amt ra
  CROSS JOIN return_fees_amt rf
  CROSS JOIN order_tax t;
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
  WITH bounds AS (
    SELECT * FROM public.shopify_analytics_resolve_period_bounds(_from_iso, _to_iso)
  ),
  bd AS (
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
      t.customers_count
    FROM public.get_selected_salespeople_scope_metrics_timeseries(
      _viewer_user_id, _salesperson_user_ids, _from_iso, _to_iso, 'day'
    ) t
  ),
  unfulfilled AS (
    SELECT count(*)::bigint AS c
    FROM public.shopify_orders o
    CROSS JOIN bounds b
    INNER JOIN public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids) sci
      ON sci.customer_id = o.customer_id
    WHERE coalesce(o.test_order, false) = false
      AND o.fulfillment_status IN ('unfulfilled', 'partial', 'on_hold')
      AND public.shopify_order_reporting_day_in_period(o.shopify_created_at, b.from_iso, b.to_iso)
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
  WITH bounds AS (
    SELECT * FROM public.shopify_analytics_resolve_period_bounds(_from_iso, _to_iso)
  ),
  viewer_flags AS (
    SELECT public.has_role(auth.uid(), 'admin') AS is_admin
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
    FROM bounds b
    INNER JOIN public.shopify_analytics_period_facts f
      ON f.reporting_day IN (
        SELECT d FROM public.shopify_reporting_days_in_period(b.from_iso, b.to_iso) d
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
  scoped_in_period AS (
    SELECT o.id, o.shopify_created_at, o.financial_status, o.subtotal, o.reporting_line_items_gross,
      o.reporting_original_total_discounts, o.reporting_total_discounts, o.reporting_total_shipping,
      o.shopify_order_id
    FROM public.shopify_orders o
    CROSS JOIN bounds b
    INNER JOIN scoped_customers sc
      ON o.customer_id = sc.customer_id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND sc.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = sc.shopify_customer_id
      )
    WHERE coalesce(o.test_order, false) = false
      AND public.shopify_order_reporting_day_in_period(o.shopify_created_at, b.from_iso, b.to_iso)
  ),
  scoped_lines AS (
    SELECT
      s.id,
      s.shopify_created_at,
      public.normalize_financial_status(s.financial_status) AS st,
      coalesce(
        f.gross_sales,
        public.shopify_order_analytics_gross(s.subtotal, s.reporting_line_items_gross)
      ) AS line_gross_raw,
      coalesce(
        f.discounts,
        public.shopify_order_analytics_discount(
          s.id,
          s.subtotal,
          s.reporting_original_total_discounts,
          s.reporting_total_discounts,
          s.reporting_line_items_gross
        )
      ) AS disc_raw,
      coalesce(s.reporting_total_shipping, 0)::numeric AS ship_raw
    FROM scoped_in_period s
    LEFT JOIN public.shopify_analytics_order_facts f
      ON f.shopify_order_id = s.shopify_order_id
     AND f.reporting_day = public.shopify_reporting_day_bucket(s.shopify_created_at)::date
  ),
  scoped_bucketed AS (
    SELECT
      CASE
        WHEN _bucket = 'day'
          THEN to_char(public.shopify_reporting_day_bucket(l.shopify_created_at), 'YYYY-MM-DD')
        ELSE to_char(public.shopify_reporting_month_bucket(l.shopify_created_at), 'YYYY-MM')
      END AS bucket_key,
      CASE
        WHEN _bucket = 'day'
          THEN to_char(public.shopify_reporting_day_bucket(l.shopify_created_at), 'DD Mon')
        ELSE to_char(public.shopify_reporting_month_bucket(l.shopify_created_at), 'Mon YYYY')
      END AS bucket_label,
      count(*) FILTER (WHERE l.st <> 'voided')::bigint AS orders_count,
      coalesce(sum(
        CASE
          WHEN l.st = 'voided' THEN 0::numeric
          ELSE (l.line_gross_raw - l.disc_raw + l.ship_raw)
        END
      ), 0)::numeric(14,2) AS revenue
    FROM scoped_lines l
    GROUP BY 1, 2
  )
  SELECT fb.bucket_key, fb.bucket_label, fb.orders_count, fb.revenue
  FROM fact_bucketed fb
  CROSS JOIN viewer_flags vf
  WHERE vf.is_admin
  UNION ALL
  SELECT sb.bucket_key, sb.bucket_label, sb.orders_count, sb.revenue
  FROM scoped_bucketed sb
  CROSS JOIN viewer_flags vf
  WHERE NOT vf.is_admin
  ORDER BY 1 ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_selected_salespeople_shopify_sales_breakdown(uuid, uuid[], timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_selected_salespeople_shopify_analytics_dashboard(uuid, uuid[], timestamptz, timestamptz) TO authenticated, service_role;
