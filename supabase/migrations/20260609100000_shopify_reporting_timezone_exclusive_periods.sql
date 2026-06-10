-- Anchor Shopify reporting to Asia/Dubai (GMT+04:00) and use exclusive period end boundaries.
-- _from_iso: inclusive start (UTC)
-- _to_iso: exclusive end (UTC) — records satisfy: ts >= _from_iso AND ts < _to_iso

CREATE OR REPLACE FUNCTION public.shopify_reporting_timezone()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'Asia/Dubai'::text;
$$;

CREATE OR REPLACE FUNCTION public.shopify_reporting_ts_in_period(
  _ts timestamptz,
  _from_iso timestamptz,
  _to_iso timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (_from_iso IS NULL OR _ts >= _from_iso)
     AND (_to_iso IS NULL OR _ts < _to_iso);
$$;

CREATE OR REPLACE FUNCTION public.shopify_reporting_day_bucket(_ts timestamptz)
RETURNS timestamp without time zone
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT date_trunc('day', _ts AT TIME ZONE public.shopify_reporting_timezone());
$$;

CREATE OR REPLACE FUNCTION public.shopify_reporting_month_bucket(_ts timestamptz)
RETURNS timestamp without time zone
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT date_trunc('month', _ts AT TIME ZONE public.shopify_reporting_timezone());
$$;

GRANT EXECUTE ON FUNCTION public.shopify_reporting_timezone() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_reporting_ts_in_period(timestamptz, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_reporting_day_bucket(timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_reporting_month_bucket(timestamptz) TO authenticated, service_role;


-- Patched from 20260608180200_fix_returns_include_same_day_refunds.sql
CREATE OR REPLACE FUNCTION public.shopify_analytics_returns_for_scope(
  _from_iso timestamptz,
  _to_iso timestamptz,
  _in_period_order_ids uuid[],
  _all_scoped_order_ids uuid[]
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH refund_event_returns AS (
    SELECT coalesce(sum(re.amount), 0)::numeric AS amt
    FROM public.shopify_refund_events re
    INNER JOIN unnest(_all_scoped_order_ids) s(id) ON s.id = re.order_id
    WHERE (_from_iso IS NULL OR re.processed_at >= _from_iso)
      AND (_to_iso IS NULL OR re.processed_at < _to_iso)
  ),
  refund_delta_returns AS (
    SELECT coalesce(sum(d.amount), 0)::numeric AS amt
    FROM public.shopify_order_refund_deltas d
    INNER JOIN unnest(_all_scoped_order_ids) s(id) ON s.id = d.order_id
    WHERE (_from_iso IS NULL OR d.recorded_at >= _from_iso)
      AND (_to_iso IS NULL OR d.recorded_at < _to_iso)
      AND NOT EXISTS (
        SELECT 1
        FROM public.shopify_refund_events re
        WHERE re.order_id = d.order_id
          AND (_from_iso IS NULL OR re.processed_at >= _from_iso)
          AND (_to_iso IS NULL OR re.processed_at < _to_iso)
      )
  ),
  in_period_fallback_returns AS (
    SELECT coalesce(sum(
      public.shopify_order_effective_returns(
        o.financial_status,
        o.total,
        o.current_total,
        o.original_total,
        o.reporting_total_refunded
      )
    ), 0)::numeric AS amt
    FROM public.shopify_orders o
    INNER JOIN unnest(_in_period_order_ids) s(id) ON s.id = o.id
    WHERE public.normalize_financial_status(o.financial_status) <> 'voided'
      AND NOT EXISTS (
        SELECT 1
        FROM public.shopify_refund_events re
        WHERE re.order_id = o.id
          AND (_from_iso IS NULL OR re.processed_at >= _from_iso)
          AND (_to_iso IS NULL OR re.processed_at < _to_iso)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.shopify_order_refund_deltas d
        WHERE d.order_id = o.id
          AND (_from_iso IS NULL OR d.recorded_at >= _from_iso)
          AND (_to_iso IS NULL OR d.recorded_at < _to_iso)
      )
  )
  SELECT round(
    (SELECT amt FROM refund_event_returns)
    + (SELECT amt FROM refund_delta_returns)
    + (SELECT amt FROM in_period_fallback_returns),
    2
  );
$$;


-- Patched from 20260608190000_shopify_breakdown_return_fees.sql
CREATE OR REPLACE FUNCTION public.shopify_analytics_return_fees_for_scope(
  _from_iso timestamptz,
  _to_iso timestamptz,
  _all_scoped_order_ids uuid[]
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT round(coalesce(sum(re.return_fees), 0)::numeric, 2)
  FROM public.shopify_refund_events re
  INNER JOIN unnest(_all_scoped_order_ids) s(id) ON s.id = re.order_id
  WHERE (_from_iso IS NULL OR re.processed_at >= _from_iso)
    AND (_to_iso IS NULL OR re.processed_at < _to_iso);
$$;

DROP FUNCTION IF EXISTS public.get_scope_shopify_sales_breakdown(uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.get_selected_salespeople_shopify_sales_breakdown(uuid, uuid[], timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.get_scope_shopify_analytics_dashboard(uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.get_selected_salespeople_shopify_analytics_dashboard(uuid, uuid[], timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.get_scope_shopify_sales_breakdown_for_viewers(uuid[], timestamptz, timestamptz);

-- Patch breakdown RPCs: add return_fees column; total = net + ship - return_fees + tax


-- Patched from 20260608190000_shopify_breakdown_return_fees.sql
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
      public.shopify_order_analytics_gross(o.subtotal, o.reporting_line_items_gross) AS line_gross_raw,
      public.shopify_order_analytics_discount(
        o.id, o.subtotal, o.reporting_original_total_discounts,
        o.reporting_total_discounts, o.reporting_line_items_gross
      ) AS disc_raw,
      coalesce(o.reporting_total_shipping, 0)::numeric AS ship_raw,
      o.subtotal AS r_subtotal,
      o.reporting_line_items_gross AS r_gross
    FROM public.shopify_orders o
    INNER JOIN in_period_order_ids s ON s.id = o.id
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
  net AS (
    SELECT r.sum_gross - r.sum_disc - ra.amt AS net_sales
    FROM rolled r
    CROSS JOIN returns_amt ra
  ),
  tax AS (
    SELECT round((n.net_sales * public.shopify_analytics_vat_rate())::numeric, 2) AS amt
    FROM net n
  )
  SELECT
    r.sum_gross::numeric(14,2),
    r.sum_disc::numeric(14,2),
    ra.amt::numeric(14,2),
    n.net_sales::numeric(14,2),
    r.sum_ship::numeric(14,2),
    rf.amt::numeric(14,2),
    t.amt::numeric(14,2),
    (
      n.net_sales + r.sum_ship - rf.amt + t.amt
    )::numeric(14,2),
    r.cnt,
    r.missing_cnt
  FROM rolled r
  CROSS JOIN returns_amt ra
  CROSS JOIN return_fees_amt rf
  CROSS JOIN net n
  CROSS JOIN tax t;
$$;


-- Patched from 20260608190000_shopify_breakdown_return_fees.sql
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
  WITH scoped_customer_ids AS (
    SELECT customer_id
    FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids)
  ),
  scoped_customers AS (
    SELECT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    INNER JOIN scoped_customer_ids sci ON sci.customer_id = c.id
  ),
  in_period_orders AS (
    SELECT o.id, o.financial_status, o.subtotal, o.reporting_line_items_gross,
      o.reporting_original_total_discounts, o.reporting_total_discounts, o.reporting_total_shipping
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) < _to_iso)
    UNION ALL
    SELECT o.id, o.financial_status, o.subtotal, o.reporting_line_items_gross,
      o.reporting_original_total_discounts, o.reporting_total_discounts, o.reporting_total_shipping
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL AND o.shopify_customer_id = sc.shopify_customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) < _to_iso)
  ),
  all_scoped_orders AS (
    SELECT o.id FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    WHERE coalesce(o.test_order, false) = false
    UNION
    SELECT o.id FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL AND o.shopify_customer_id = sc.shopify_customer_id
    WHERE coalesce(o.test_order, false) = false
  ),
  scoped_orders AS (
    SELECT DISTINCT ON (id) * FROM in_period_orders ORDER BY id
  ),
  lines AS (
    SELECT
      id AS o_id,
      public.normalize_financial_status(financial_status) AS st,
      public.shopify_order_analytics_gross(subtotal, reporting_line_items_gross) AS line_gross_raw,
      public.shopify_order_analytics_discount(
        id, subtotal, reporting_original_total_discounts, reporting_total_discounts, reporting_line_items_gross
      ) AS disc_raw,
      coalesce(reporting_total_shipping, 0)::numeric AS ship_raw,
      subtotal AS r_subtotal,
      reporting_line_items_gross AS r_gross
    FROM scoped_orders
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
      ARRAY(SELECT id FROM scoped_orders),
      ARRAY(SELECT id FROM all_scoped_orders)
    ) AS amt
  ),
  return_fees_amt AS (
    SELECT public.shopify_analytics_return_fees_for_scope(
      _from_iso, _to_iso,
      ARRAY(SELECT id FROM all_scoped_orders)
    ) AS amt
  ),
  net AS (
    SELECT r.sum_gross - r.sum_disc - ra.amt AS net_sales
    FROM rolled r CROSS JOIN returns_amt ra
  ),
  tax AS (
    SELECT round((n.net_sales * public.shopify_analytics_vat_rate())::numeric, 2) AS amt FROM net n
  )
  SELECT
    r.sum_gross::numeric(14,2),
    r.sum_disc::numeric(14,2),
    ra.amt::numeric(14,2),
    n.net_sales::numeric(14,2),
    r.sum_ship::numeric(14,2),
    rf.amt::numeric(14,2),
    t.amt::numeric(14,2),
    (n.net_sales + r.sum_ship - rf.amt + t.amt)::numeric(14,2),
    r.cnt,
    r.missing_cnt
  FROM rolled r
  CROSS JOIN returns_amt ra
  CROSS JOIN return_fees_amt rf
  CROSS JOIN net n
  CROSS JOIN tax t;
$$;


-- Patched from 20260608190000_shopify_breakdown_return_fees.sql
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
    fin.orders_total_count,
    fin.orders_paid_count,
    fin.orders_pending_count,
    fin.orders_refunded_count,
    u.c,
    fin.customers_count,
    CASE
      WHEN fin.orders_total_count > 0 THEN round((bd.total_sales_check / fin.orders_total_count)::numeric, 2)
      ELSE 0::numeric
    END,
    bd.orders_missing_reporting
  FROM bd
  CROSS JOIN fin
  CROSS JOIN unfulfilled u;
$$;


-- Patched from 20260608190000_shopify_breakdown_return_fees.sql
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
      t.customers_count
    FROM public.get_selected_salespeople_scope_metrics_timeseries(
      _viewer_user_id, _salesperson_user_ids, _from_iso, _to_iso, 'day'
    ) t
  ),
  unfulfilled AS (
    SELECT count(*)::bigint AS c
    FROM public.shopify_orders o
    INNER JOIN public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids) sci
      ON sci.customer_id = o.customer_id
    WHERE coalesce(o.test_order, false) = false
      AND o.fulfillment_status IN ('unfulfilled', 'partial', 'on_hold')
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
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
    fin.orders_total_count,
    fin.orders_paid_count,
    fin.orders_pending_count,
    fin.orders_refunded_count,
    u.c,
    fin.customers_count,
    CASE
      WHEN fin.orders_total_count > 0 THEN round((bd.total_sales_check / fin.orders_total_count)::numeric, 2)
      ELSE 0::numeric
    END,
    bd.orders_missing_reporting
  FROM bd
  CROSS JOIN fin
  CROSS JOIN unfulfilled u;
$$;


-- Patched from 20260608190000_shopify_breakdown_return_fees.sql
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
      coalesce(sum(m.return_fees), 0)::numeric(14,2) AS return_fees,
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


-- Patched from 20260608140100_patch_financial_rpcs_effective_totals.sql
CREATE OR REPLACE FUNCTION public.get_scope_financial_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  customers_count BIGINT,
  orders_total_count BIGINT,
  orders_paid_count BIGINT,
  orders_pending_count BIGINT,
  orders_refunded_count BIGINT,
  original_gross_sales NUMERIC(14,2),
  current_gross_sales NUMERIC(14,2),
  net_sales_ex_vat NUMERIC(14,2),
  vat_collected NUMERIC(14,2),
  refunded_returned_value NUMERIC(14,2),
  avg_order_original_gross NUMERIC(14,2),
  avg_order_current_gross NUMERIC(14,2),
  avg_order_net_ex_vat NUMERIC(14,2),
  orders_missing_current_total BIGINT
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
  filtered_scoped_customers AS (
    SELECT sc.customer_id
    FROM scoped_customers sc
    INNER JOIN public.shopify_customers c ON c.id = sc.customer_id
    WHERE (_from_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) < _to_iso)
  ),
  admin_orders AS (
    SELECT
      o.id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.original_total, o.total, 0)::numeric
      END AS eff_orig,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_total_sales(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_curr,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.total_tax, 0)::numeric
      END AS eff_tax,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_returns(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_refund,
      public.normalize_financial_status(o.financial_status) AS status_norm,
      (
        o.current_total IS NULL
        AND public.normalize_financial_status(o.financial_status) <> 'voided'
      ) AS missing_curr
    FROM public.shopify_orders o
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_orders_direct AS (
    SELECT DISTINCT
      o.id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.original_total, o.total, 0)::numeric
      END AS eff_orig,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_total_sales(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_curr,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.total_tax, 0)::numeric
      END AS eff_tax,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_returns(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_refund,
      public.normalize_financial_status(o.financial_status) AS status_norm,
      (
        o.current_total IS NULL
        AND public.normalize_financial_status(o.financial_status) <> 'voided'
      ) AS missing_curr
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_orders_fallback AS (
    SELECT DISTINCT
      o.id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.original_total, o.total, 0)::numeric
      END AS eff_orig,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_total_sales(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_curr,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.total_tax, 0)::numeric
      END AS eff_tax,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_returns(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_refund,
      public.normalize_financial_status(o.financial_status) AS status_norm,
      (
        o.current_total IS NULL
        AND public.normalize_financial_status(o.financial_status) <> 'voided'
      ) AS missing_curr
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_orders AS (
    SELECT DISTINCT ON (id)
      id,
      eff_orig,
      eff_curr,
      eff_tax,
      eff_refund,
      status_norm,
      missing_curr
    FROM (
      SELECT * FROM admin_orders
      UNION ALL
      SELECT * FROM scoped_orders_direct
      UNION ALL
      SELECT * FROM scoped_orders_fallback
    ) u
    ORDER BY id, missing_curr DESC
  ),
  sums AS (
    SELECT
      count(*)::bigint AS c_orders_total,
      count(*) FILTER (WHERE status_norm IN ('paid', 'partially_paid'))::bigint AS c_orders_paid,
      count(*) FILTER (WHERE status_norm IN ('pending', 'authorized'))::bigint AS c_orders_pending,
      count(*) FILTER (WHERE status_norm IN ('refunded', 'partially_refunded', 'voided'))::bigint AS c_orders_refunded,
      count(*) FILTER (WHERE missing_curr)::bigint AS c_orders_missing_current_total,
      coalesce(sum(eff_orig), 0)::numeric(14,2) AS c_original,
      coalesce(sum(eff_curr), 0)::numeric(14,2) AS c_current,
      coalesce(sum(eff_curr - eff_tax), 0)::numeric(14,2) AS c_net_ex_vat,
      coalesce(sum(eff_tax), 0)::numeric(14,2) AS c_vat,
      coalesce(sum(eff_refund), 0)::numeric(14,2) AS c_refund
    FROM scoped_orders
  )
  SELECT
    (SELECT count(*)::bigint FROM filtered_scoped_customers) AS customers_count,
    s.c_orders_total AS orders_total_count,
    s.c_orders_paid AS orders_paid_count,
    s.c_orders_pending AS orders_pending_count,
    s.c_orders_refunded AS orders_refunded_count,
    s.c_original AS original_gross_sales,
    s.c_current AS current_gross_sales,
    s.c_net_ex_vat AS net_sales_ex_vat,
    s.c_vat AS vat_collected,
    s.c_refund AS refunded_returned_value,
    CASE
      WHEN s.c_orders_total > 0 THEN round((s.c_original / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_original_gross,
    CASE
      WHEN s.c_orders_total > 0 THEN round((s.c_current / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_current_gross,
    CASE
      WHEN s.c_orders_total > 0 THEN round((s.c_net_ex_vat / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net_ex_vat,
    s.c_orders_missing_current_total AS orders_missing_current_total
  FROM sums s;
$$;


-- Patched from 20260608140100_patch_financial_rpcs_effective_totals.sql
CREATE OR REPLACE FUNCTION public.get_scope_financial_breakdown_for_viewers(
  _viewer_user_ids UUID[],
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  customers_count BIGINT,
  orders_total_count BIGINT,
  orders_paid_count BIGINT,
  orders_pending_count BIGINT,
  orders_refunded_count BIGINT,
  original_gross_sales NUMERIC(14,2),
  current_gross_sales NUMERIC(14,2),
  net_sales_ex_vat NUMERIC(14,2),
  vat_collected NUMERIC(14,2),
  refunded_returned_value NUMERIC(14,2),
  avg_order_original_gross NUMERIC(14,2),
  avg_order_current_gross NUMERIC(14,2),
  avg_order_net_ex_vat NUMERIC(14,2),
  orders_missing_current_total BIGINT
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
      coalesce(sum(m.customers_count), 0)::bigint AS customers_count,
      coalesce(sum(m.orders_total_count), 0)::bigint AS orders_total_count,
      coalesce(sum(m.orders_paid_count), 0)::bigint AS orders_paid_count,
      coalesce(sum(m.orders_pending_count), 0)::bigint AS orders_pending_count,
      coalesce(sum(m.orders_refunded_count), 0)::bigint AS orders_refunded_count,
      coalesce(sum(m.original_gross_sales), 0)::numeric(14,2) AS original_gross_sales,
      coalesce(sum(m.current_gross_sales), 0)::numeric(14,2) AS current_gross_sales,
      coalesce(sum(m.net_sales_ex_vat), 0)::numeric(14,2) AS net_sales_ex_vat,
      coalesce(sum(m.vat_collected), 0)::numeric(14,2) AS vat_collected,
      coalesce(sum(m.refunded_returned_value), 0)::numeric(14,2) AS refunded_returned_value,
      coalesce(sum(m.orders_missing_current_total), 0)::bigint AS orders_missing_current_total
    FROM input_viewers iv
    LEFT JOIN LATERAL public.get_scope_financial_breakdown(
      iv.viewer_user_id,
      _from_iso,
      _to_iso
    ) m ON true
  )
  SELECT
    s.customers_count,
    s.orders_total_count,
    s.orders_paid_count,
    s.orders_pending_count,
    s.orders_refunded_count,
    s.original_gross_sales,
    s.current_gross_sales,
    s.net_sales_ex_vat,
    s.vat_collected,
    s.refunded_returned_value,
    CASE
      WHEN s.orders_total_count > 0 THEN round((s.original_gross_sales / s.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_original_gross,
    CASE
      WHEN s.orders_total_count > 0 THEN round((s.current_gross_sales / s.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_current_gross,
    CASE
      WHEN s.orders_total_count > 0 THEN round((s.net_sales_ex_vat / s.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net_ex_vat,
    s.orders_missing_current_total
  FROM scoped s;
$$;


-- Patched from 20260608140100_patch_financial_rpcs_effective_totals.sql
CREATE OR REPLACE FUNCTION public.get_salesperson_financial_breakdown_rows(
  _leader_user_id UUID DEFAULT NULL,
  _leader_role TEXT DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  salesperson_user_id UUID,
  salesperson_name TEXT,
  customers_count BIGINT,
  orders_total_count BIGINT,
  orders_paid_count BIGINT,
  orders_pending_count BIGINT,
  orders_refunded_count BIGINT,
  original_gross_sales NUMERIC(14,2),
  current_gross_sales NUMERIC(14,2),
  net_sales_ex_vat NUMERIC(14,2),
  vat_collected NUMERIC(14,2),
  refunded_returned_value NUMERIC(14,2),
  avg_order_original_gross NUMERIC(14,2),
  avg_order_current_gross NUMERIC(14,2),
  avg_order_net_ex_vat NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH salesperson_base AS (
    SELECT
      ur.user_id AS salesperson_user_id,
      COALESCE(NULLIF(max(ur.salesperson_name), ''), 'Salesperson') AS salesperson_name
    FROM public.user_roles ur
    WHERE ur.role = 'salesperson'
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur_leader
        WHERE ur_leader.user_id = ur.user_id
          AND ur_leader.role IN ('manager', 'supervisor', 'admin', 'owner')
      )
    GROUP BY ur.user_id
  ),
  visibility_scope AS (
    SELECT sb.salesperson_user_id, sb.salesperson_name
    FROM salesperson_base sb
    WHERE
      public.has_role(auth.uid(), 'admin')
      OR (
        public.has_role(auth.uid(), 'salesperson')
        AND sb.salesperson_user_id = auth.uid()
      )
      OR (
        _leader_user_id IS NOT NULL
        AND auth.uid() = _leader_user_id
        AND COALESCE(_leader_role, '') IN ('manager', 'supervisor')
        AND (
          (_leader_role = 'manager' AND public.has_role(auth.uid(), 'manager'))
          OR (_leader_role = 'supervisor' AND public.has_role(auth.uid(), 'supervisor'))
        )
        AND sb.salesperson_user_id IN (
          SELECT e.member_user_id
          FROM public.sales_hierarchy_edges e
          WHERE e.leader_user_id = _leader_user_id
            AND e.leader_role::text = _leader_role
        )
      )
      OR (
        public.has_role(auth.uid(), 'supervisor')
        AND COALESCE(_leader_role, '') = 'manager'
        AND _leader_user_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.sales_hierarchy_edges e_sup
          WHERE e_sup.leader_user_id = auth.uid()
            AND e_sup.leader_role::text = 'supervisor'
            AND e_sup.member_user_id = _leader_user_id
        )
        AND sb.salesperson_user_id IN (
          SELECT e_m.member_user_id
          FROM public.sales_hierarchy_edges e_m
          WHERE e_m.leader_user_id = _leader_user_id
            AND e_m.leader_role::text = 'manager'
        )
      )
  ),
  assignment_customers AS (
    SELECT DISTINCT
      a.salesperson_user_id,
      a.customer_id,
      c.shopify_customer_id,
      c.shopify_created_at,
      c.created_at
    FROM public.salesperson_customer_assignments a
    LEFT JOIN public.shopify_customers c ON c.id = a.customer_id
  ),
  customer_rollup AS (
    SELECT
      ac.salesperson_user_id,
      count(DISTINCT ac.customer_id)::bigint AS customers_count
    FROM assignment_customers ac
    WHERE (_from_iso IS NULL OR coalesce(ac.shopify_created_at, ac.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(ac.shopify_created_at, ac.created_at) < _to_iso)
    GROUP BY ac.salesperson_user_id
  ),
  order_matches AS (
    SELECT
      ac.salesperson_user_id,
      o.id AS order_id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.original_total, o.total, 0)::numeric
      END AS eff_orig,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_total_sales(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_curr,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.total_tax, 0)::numeric
      END AS eff_tax,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_returns(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_refund,
      public.normalize_financial_status(o.financial_status) AS status_norm
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o ON o.customer_id = ac.customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
      AND coalesce(o.test_order, false) = false
    UNION
    SELECT
      ac.salesperson_user_id,
      o.id AS order_id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.original_total, o.total, 0)::numeric
      END AS eff_orig,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_total_sales(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_curr,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.total_tax, 0)::numeric
      END AS eff_tax,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_returns(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_refund,
      public.normalize_financial_status(o.financial_status) AS status_norm
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND ac.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = ac.shopify_customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  order_rollup AS (
    SELECT
      om.salesperson_user_id,
      count(DISTINCT om.order_id)::bigint AS orders_total_count,
      count(DISTINCT om.order_id) FILTER (WHERE om.status_norm IN ('paid', 'partially_paid'))::bigint AS orders_paid_count,
      count(DISTINCT om.order_id) FILTER (WHERE om.status_norm IN ('pending', 'authorized'))::bigint AS orders_pending_count,
      count(DISTINCT om.order_id) FILTER (WHERE om.status_norm IN ('refunded', 'partially_refunded', 'voided'))::bigint AS orders_refunded_count,
      coalesce(sum(om.eff_orig), 0)::numeric(14,2) AS original_gross_sales,
      coalesce(sum(om.eff_curr), 0)::numeric(14,2) AS current_gross_sales,
      coalesce(sum(om.eff_curr - om.eff_tax), 0)::numeric(14,2) AS net_sales_ex_vat,
      coalesce(sum(om.eff_tax), 0)::numeric(14,2) AS vat_collected,
      coalesce(sum(om.eff_refund), 0)::numeric(14,2) AS refunded_returned_value
    FROM (
      SELECT DISTINCT salesperson_user_id, order_id, eff_orig, eff_curr, eff_tax, eff_refund, status_norm
      FROM order_matches
    ) om
    GROUP BY om.salesperson_user_id
  )
  SELECT
    v.salesperson_user_id,
    v.salesperson_name,
    coalesce(cr.customers_count, 0) AS customers_count,
    coalesce(orw.orders_total_count, 0) AS orders_total_count,
    coalesce(orw.orders_paid_count, 0) AS orders_paid_count,
    coalesce(orw.orders_pending_count, 0) AS orders_pending_count,
    coalesce(orw.orders_refunded_count, 0) AS orders_refunded_count,
    coalesce(orw.original_gross_sales, 0)::numeric(14,2) AS original_gross_sales,
    coalesce(orw.current_gross_sales, 0)::numeric(14,2) AS current_gross_sales,
    coalesce(orw.net_sales_ex_vat, 0)::numeric(14,2) AS net_sales_ex_vat,
    coalesce(orw.vat_collected, 0)::numeric(14,2) AS vat_collected,
    coalesce(orw.refunded_returned_value, 0)::numeric(14,2) AS refunded_returned_value,
    CASE
      WHEN coalesce(orw.orders_total_count, 0) > 0 THEN round((coalesce(orw.original_gross_sales, 0) / orw.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_original_gross,
    CASE
      WHEN coalesce(orw.orders_total_count, 0) > 0 THEN round((coalesce(orw.current_gross_sales, 0) / orw.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_current_gross,
    CASE
      WHEN coalesce(orw.orders_total_count, 0) > 0 THEN round((coalesce(orw.net_sales_ex_vat, 0) / orw.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net_ex_vat
  FROM visibility_scope v
  LEFT JOIN customer_rollup cr ON cr.salesperson_user_id = v.salesperson_user_id
  LEFT JOIN order_rollup orw ON orw.salesperson_user_id = v.salesperson_user_id
  ORDER BY coalesce(orw.current_gross_sales, 0) DESC, v.salesperson_name ASC;
$$;


-- Patched from 20260608140100_patch_financial_rpcs_effective_totals.sql
CREATE OR REPLACE FUNCTION public.get_selected_salespeople_scope_metrics_timeseries(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _bucket TEXT DEFAULT 'month'
)
RETURNS TABLE (
  orders_count BIGINT,
  customers_count BIGINT,
  revenue NUMERIC(14,2),
  avg_order_value NUMERIC(14,2),
  orders_total_count BIGINT,
  orders_paid_count BIGINT,
  orders_pending_count BIGINT,
  orders_refunded_count BIGINT,
  original_gross_sales NUMERIC(14,2),
  current_gross_sales NUMERIC(14,2),
  net_sales_ex_vat NUMERIC(14,2),
  vat_collected NUMERIC(14,2),
  refunded_returned_value NUMERIC(14,2),
  avg_order_original_gross NUMERIC(14,2),
  avg_order_current_gross NUMERIC(14,2),
  avg_order_net_ex_vat NUMERIC(14,2),
  orders_missing_current_total BIGINT,
  series JSONB
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
      c.shopify_customer_id,
      coalesce(c.shopify_created_at, c.created_at) AS customer_created_at
    FROM public.shopify_customers c
    INNER JOIN scoped_customer_ids sci ON sci.customer_id = c.id
  ),
  filtered_customers AS (
    SELECT customer_id
    FROM scoped_customers
    WHERE (_from_iso IS NULL OR customer_created_at >= _from_iso)
      AND (_to_iso IS NULL OR customer_created_at < _to_iso)
  ),
  order_matches AS (
    SELECT
      o.id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.original_total, o.total, 0)::numeric
      END AS eff_orig,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_total_sales(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_curr,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.total_tax, 0)::numeric
      END AS eff_tax,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_returns(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_refund,
      lower(trim(coalesce(o.financial_status, ''))) AS financial_status_norm,
      coalesce(o.shopify_created_at, o.created_at) AS order_created_at,
      (
        o.current_total IS NULL
        AND public.normalize_financial_status(o.financial_status) <> 'voided'
      ) AS missing_curr
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) < _to_iso)

    UNION

    SELECT
      o.id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.original_total, o.total, 0)::numeric
      END AS eff_orig,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_total_sales(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_curr,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.total_tax, 0)::numeric
      END AS eff_tax,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE public.shopify_order_effective_returns(
          o.financial_status, o.total, o.current_total, o.original_total, o.reporting_total_refunded
        )::numeric
      END AS eff_refund,
      lower(trim(coalesce(o.financial_status, ''))) AS financial_status_norm,
      coalesce(o.shopify_created_at, o.created_at) AS order_created_at,
      (
        o.current_total IS NULL
        AND public.normalize_financial_status(o.financial_status) <> 'voided'
      ) AS missing_curr
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) < _to_iso)
  ),
  scoped_orders AS (
    SELECT DISTINCT ON (id)
      id,
      eff_orig,
      eff_curr,
      eff_tax,
      eff_refund,
      CASE
        WHEN financial_status_norm = 'partially paid' THEN 'partially_paid'
        WHEN financial_status_norm = 'partially refunded' THEN 'partially_refunded'
        WHEN financial_status_norm = '' THEN 'pending'
        ELSE financial_status_norm
      END AS financial_status_norm,
      order_created_at,
      missing_curr
    FROM order_matches
    ORDER BY id, missing_curr DESC
  ),
  order_agg AS (
    SELECT
      count(*)::bigint AS orders_total_count,
      coalesce(sum(eff_orig), 0)::numeric(14,2) AS original_gross_sales,
      coalesce(sum(eff_curr), 0)::numeric(14,2) AS current_gross_sales,
      coalesce(sum(eff_curr - eff_tax), 0)::numeric(14,2) AS net_sales_ex_vat,
      coalesce(sum(eff_tax), 0)::numeric(14,2) AS vat_collected,
      coalesce(sum(eff_refund), 0)::numeric(14,2) AS refunded_returned_value,
      count(*) FILTER (WHERE missing_curr)::bigint AS orders_missing_current_total,
      count(*) FILTER (
        WHERE financial_status_norm IN ('paid', 'partially_paid')
      )::bigint AS orders_paid_count,
      count(*) FILTER (
        WHERE financial_status_norm IN ('refunded', 'partially_refunded', 'voided')
      )::bigint AS orders_refunded_count
    FROM scoped_orders
  ),
  timeseries AS (
    SELECT
      CASE
        WHEN _bucket = 'day'
          THEN to_char(public.shopify_reporting_day_bucket(order_created_at), 'YYYY-MM-DD')
        ELSE to_char(public.shopify_reporting_month_bucket(order_created_at), 'YYYY-MM')
      END AS bucket_key,
      CASE
        WHEN _bucket = 'day'
          THEN to_char(public.shopify_reporting_day_bucket(order_created_at), 'DD Mon')
        ELSE to_char(public.shopify_reporting_month_bucket(order_created_at), 'Mon YYYY')
      END AS bucket_label,
      count(*)::bigint AS orders_count,
      coalesce(sum(eff_curr), 0)::numeric(14,2) AS revenue
    FROM scoped_orders
    GROUP BY 1, 2
  ),
  series_json AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'label', t.bucket_label,
          'revenue', t.revenue,
          'orders', t.orders_count
        )
        ORDER BY t.bucket_key
      ),
      '[]'::jsonb
    ) AS series
    FROM timeseries t
  )
  SELECT
    oa.orders_total_count AS orders_count,
    (SELECT count(*)::bigint FROM filtered_customers) AS customers_count,
    oa.current_gross_sales AS revenue,
    CASE
      WHEN oa.orders_total_count > 0 THEN round((oa.current_gross_sales / oa.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_value,
    oa.orders_total_count,
    oa.orders_paid_count,
    greatest(oa.orders_total_count - oa.orders_paid_count - oa.orders_refunded_count, 0)::bigint AS orders_pending_count,
    oa.orders_refunded_count,
    oa.original_gross_sales,
    oa.current_gross_sales,
    oa.net_sales_ex_vat,
    oa.vat_collected,
    oa.refunded_returned_value,
    CASE
      WHEN oa.orders_total_count > 0 THEN round((oa.original_gross_sales / oa.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_original_gross,
    CASE
      WHEN oa.orders_total_count > 0 THEN round((oa.current_gross_sales / oa.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_current_gross,
    CASE
      WHEN oa.orders_total_count > 0 THEN round((oa.net_sales_ex_vat / oa.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net_ex_vat,
    oa.orders_missing_current_total,
    sj.series
  FROM order_agg oa
  CROSS JOIN series_json sj;
$$;


-- Patched from 20260608140100_patch_financial_rpcs_effective_totals.sql
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
  bucketed AS (
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
    b.bucket_key,
    b.bucket_label,
    b.orders_count,
    b.revenue
  FROM bucketed b
  ORDER BY b.bucket_key ASC;
$$;


-- Patched from 20260608140100_patch_financial_rpcs_effective_totals.sql
CREATE OR REPLACE FUNCTION public.get_supervisor_selected_manager_timeseries(
  _supervisor_user_id UUID,
  _manager_user_ids UUID[] DEFAULT NULL,
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
  WITH authz AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (auth.uid() = _supervisor_user_id AND public.has_role(auth.uid(), 'supervisor')) AS is_self_supervisor
  ),
  allowed_managers AS (
    SELECT DISTINCT e.member_user_id AS manager_user_id
    FROM public.sales_hierarchy_edges e
    CROSS JOIN authz a
    WHERE
      e.leader_user_id = _supervisor_user_id
      AND e.leader_role = 'supervisor'
      AND (a.is_admin OR a.is_self_supervisor)
  ),
  target_managers AS (
    SELECT am.manager_user_id
    FROM allowed_managers am
    WHERE
      _manager_user_ids IS NULL
      OR cardinality(_manager_user_ids) = 0
      OR am.manager_user_id = ANY(_manager_user_ids)
  ),
  scoped_salespeople AS (
    SELECT DISTINCT e.member_user_id AS salesperson_user_id
    FROM public.sales_hierarchy_edges e
    INNER JOIN target_managers tm ON tm.manager_user_id = e.leader_user_id
    WHERE e.leader_role = 'manager'
  ),
  scoped_customers AS (
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.salesperson_customer_assignments a
    INNER JOIN scoped_salespeople sp ON sp.salesperson_user_id = a.salesperson_user_id
    INNER JOIN public.shopify_customers c ON c.id = a.customer_id
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
  bucketed AS (
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
    b.bucket_key,
    b.bucket_label,
    b.orders_count,
    b.revenue
  FROM bucketed b
  ORDER BY b.bucket_key ASC;
$$;


-- Patched from 20260608140100_patch_financial_rpcs_effective_totals.sql
CREATE OR REPLACE FUNCTION public.get_manager_selected_salespeople_timeseries(
  _manager_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
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
  WITH authz AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (auth.uid() = _manager_user_id AND public.has_role(auth.uid(), 'manager')) AS is_self_manager
  ),
  allowed_salespeople AS (
    SELECT DISTINCT e.member_user_id AS salesperson_user_id
    FROM public.sales_hierarchy_edges e
    CROSS JOIN authz a
    WHERE
      e.leader_user_id = _manager_user_id
      AND e.leader_role = 'manager'
      AND (a.is_admin OR a.is_self_manager)
  ),
  target_salespeople AS (
    SELECT asp.salesperson_user_id
    FROM allowed_salespeople asp
    WHERE
      _salesperson_user_ids IS NULL
      OR cardinality(_salesperson_user_ids) = 0
      OR asp.salesperson_user_id = ANY(_salesperson_user_ids)
  ),
  scoped_customers AS (
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.salesperson_customer_assignments a
    INNER JOIN target_salespeople ts ON ts.salesperson_user_id = a.salesperson_user_id
    INNER JOIN public.shopify_customers c ON c.id = a.customer_id
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
  bucketed AS (
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
    b.bucket_key,
    b.bucket_label,
    b.orders_count,
    b.revenue
  FROM bucketed b
  ORDER BY b.bucket_key ASC;
$$;


-- Patched from 20260608140100_patch_financial_rpcs_effective_totals.sql
CREATE OR REPLACE FUNCTION public.get_scope_order_metrics(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  orders_count BIGINT,
  customers_count BIGINT,
  revenue NUMERIC(14,2),
  avg_order_value NUMERIC(14,2)
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
  scoped_orders AS (
    SELECT DISTINCT
      o.id,
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
  filtered_scoped_customers AS (
    SELECT sc.customer_id
    FROM scoped_customers sc
    INNER JOIN public.shopify_customers c ON c.id = sc.customer_id
    WHERE (_from_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) < _to_iso)
  ),
  sums AS (
    SELECT
      count(*)::bigint AS c_orders,
      coalesce(sum(order_amount), 0)::numeric(14,2) AS c_revenue
    FROM scoped_orders
  )
  SELECT
    s.c_orders AS orders_count,
    (SELECT count(*)::bigint FROM filtered_scoped_customers) AS customers_count,
    s.c_revenue AS revenue,
    CASE
      WHEN s.c_orders > 0 THEN round((s.c_revenue / s.c_orders)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_value
  FROM sums s;
$$;


-- Patched from 20260430145500_add_bulk_scope_aggregates_and_manager_team_options_rpc.sql
CREATE OR REPLACE FUNCTION public.get_scope_order_metrics_for_viewers(
  _viewer_user_ids UUID[],
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  orders_count BIGINT,
  customers_count BIGINT,
  revenue NUMERIC(14,2),
  avg_order_value NUMERIC(14,2)
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
      coalesce(sum(m.orders_count), 0)::bigint AS orders_count,
      coalesce(sum(m.customers_count), 0)::bigint AS customers_count,
      coalesce(sum(m.revenue), 0)::numeric(14,2) AS revenue
    FROM input_viewers iv
    LEFT JOIN LATERAL public.get_scope_order_metrics(
      iv.viewer_user_id,
      _from_iso,
      _to_iso
    ) m ON true
  )
  SELECT
    s.orders_count,
    s.customers_count,
    s.revenue,
    CASE
      WHEN s.orders_count > 0 THEN round((s.revenue / s.orders_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_value
  FROM scoped s;
$$;


-- Patched from 20260430194000_add_customer_rfm_groups_and_scoped_filter_rpc.sql
CREATE OR REPLACE FUNCTION public.get_scoped_customers_page(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _owner_names TEXT[] DEFAULT NULL,
  _search TEXT DEFAULT NULL,
  _city_filter TEXT DEFAULT 'all',
  _assignment_filter TEXT DEFAULT 'all',
  _rfm_group_filter TEXT DEFAULT 'all',
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _sort_by TEXT DEFAULT 'total_revenue',
  _sort_dir TEXT DEFAULT 'desc',
  _page INTEGER DEFAULT 1,
  _page_size INTEGER DEFAULT 15,
  _force_scoped_filter BOOLEAN DEFAULT TRUE,
  _customer_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  row_data JSONB,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_sort_col TEXT;
  v_sort_dir TEXT;
  v_offset INTEGER;
BEGIN
  IF _viewer_user_id IS NULL THEN
    RAISE EXCEPTION 'viewer user id is required';
  END IF;

  IF auth.uid() IS NULL OR (auth.uid() <> _viewer_user_id AND NOT public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  v_sort_col := CASE coalesce(_sort_by, 'total_revenue')
    WHEN 'total_revenue' THEN 'total_revenue'
    WHEN 'total_orders' THEN 'total_orders'
    WHEN 'shopify_created_at' THEN 'shopify_created_at'
    WHEN 'name' THEN 'name'
    ELSE 'total_revenue'
  END;

  v_sort_dir := CASE lower(coalesce(_sort_dir, 'desc'))
    WHEN 'asc' THEN 'ASC'
    ELSE 'DESC'
  END;

  v_offset := GREATEST(coalesce(_page, 1), 1) - 1;
  v_offset := v_offset * GREATEST(coalesce(_page_size, 15), 1);

  RETURN QUERY EXECUTE format(
    $sql$
      WITH name_scope AS (
        SELECT DISTINCT lower(trim(nm)) AS owner_name
        FROM unnest(coalesce($3, ARRAY[]::text[])) nm
        WHERE coalesce(trim(nm), '') <> ''
      ),
      explicit_scope AS (
        SELECT DISTINCT unnest(coalesce($14, ARRAY[]::uuid[])) AS customer_id
      ),
      scoped_customers AS (
        SELECT DISTINCT t.customer_id
        FROM public.get_scoped_customer_ids_for_salespeople($1, $2) t
        UNION
        SELECT DISTINCT c.id AS customer_id
        FROM public.shopify_customers c
        INNER JOIN name_scope ns
          ON lower(trim(coalesce(c.sp_assigned, ''))) = ns.owner_name
          OR lower(trim(coalesce(c.referred_by, ''))) = ns.owner_name
        UNION
        SELECT DISTINCT es.customer_id
        FROM explicit_scope es
      ),
      filtered AS (
        SELECT c.*
        FROM public.shopify_customers c
        WHERE (
          NOT coalesce($13, true)
          OR EXISTS (SELECT 1 FROM scoped_customers sc WHERE sc.customer_id = c.id)
        )
          AND (
            coalesce(trim($4), '') = ''
            OR c.name ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
            OR c.city ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
            OR c.email ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
          )
          AND (
            coalesce($5, 'all') = 'all'
            OR c.city = $5
          )
          AND (
            $6 = 'all'
            OR ($6 = 'assigned' AND c.sp_assigned IS NOT NULL AND c.sp_assigned <> 'Unassigned')
            OR ($6 = 'unassigned' AND (c.sp_assigned IS NULL OR c.sp_assigned = 'Unassigned'))
          )
          AND (
            coalesce($7, 'all') = 'all'
            OR coalesce(c.rfm_group, 'Lost') = $7
          )
          AND ($8 IS NULL OR c.shopify_created_at >= $8)
          AND ($9 IS NULL OR c.shopify_created_at < $9)
      ),
      page_rows AS (
        SELECT
          to_jsonb(f) AS row_data,
          count(*) OVER()::bigint AS total_count
        FROM filtered f
        ORDER BY %I %s
        OFFSET $10
        LIMIT $11
      )
      SELECT p.row_data, p.total_count
      FROM page_rows p
    $sql$,
    v_sort_col,
    v_sort_dir
  )
  USING
    _viewer_user_id,
    _salesperson_user_ids,
    _owner_names,
    _search,
    _city_filter,
    _assignment_filter,
    _rfm_group_filter,
    _from_iso,
    _to_iso,
    v_offset,
    GREATEST(coalesce(_page_size, 15), 1),
    v_sort_col,
    _force_scoped_filter,
    _customer_ids;
END;
$$;


-- Patched from 20260430154500_extend_scoped_pages_with_explicit_customer_ids.sql
CREATE OR REPLACE FUNCTION public.get_scoped_orders_page(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _owner_names TEXT[] DEFAULT NULL,
  _search TEXT DEFAULT NULL,
  _status_filter TEXT DEFAULT 'all',
  _fulfillment_filter TEXT DEFAULT 'all',
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _sort_by TEXT DEFAULT 'shopify_created_at',
  _sort_dir TEXT DEFAULT 'desc',
  _page INTEGER DEFAULT 1,
  _page_size INTEGER DEFAULT 15,
  _force_scoped_filter BOOLEAN DEFAULT TRUE,
  _customer_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  row_data JSONB,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_sort_col TEXT;
  v_sort_dir TEXT;
  v_offset INTEGER;
BEGIN
  IF _viewer_user_id IS NULL THEN
    RAISE EXCEPTION 'viewer user id is required';
  END IF;

  IF auth.uid() IS NULL OR (auth.uid() <> _viewer_user_id AND NOT public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  v_sort_col := CASE coalesce(_sort_by, 'shopify_created_at')
    WHEN 'shopify_created_at' THEN 'shopify_created_at'
    WHEN 'processed_at' THEN 'processed_at'
    WHEN 'total' THEN 'total'
    WHEN 'order_number' THEN 'order_number'
    ELSE 'shopify_created_at'
  END;

  v_sort_dir := CASE lower(coalesce(_sort_dir, 'desc'))
    WHEN 'asc' THEN 'ASC'
    ELSE 'DESC'
  END;

  v_offset := GREATEST(coalesce(_page, 1), 1) - 1;
  v_offset := v_offset * GREATEST(coalesce(_page_size, 15), 1);

  RETURN QUERY EXECUTE format(
    $sql$
      WITH name_scope AS (
        SELECT DISTINCT lower(trim(nm)) AS owner_name
        FROM unnest(coalesce($3, ARRAY[]::text[])) nm
        WHERE coalesce(trim(nm), '') <> ''
      ),
      explicit_scope AS (
        SELECT
          c.id AS customer_id,
          c.shopify_customer_id
        FROM public.shopify_customers c
        WHERE c.id = ANY(coalesce($13, ARRAY[]::uuid[]))
      ),
      scoped_customers AS (
        SELECT DISTINCT
          c.id AS customer_id,
          c.shopify_customer_id
        FROM public.shopify_customers c
        WHERE EXISTS (
          SELECT 1
          FROM public.get_scoped_customer_ids_for_salespeople($1, $2) t
          WHERE t.customer_id = c.id
        )
        UNION
        SELECT DISTINCT
          c.id AS customer_id,
          c.shopify_customer_id
        FROM public.shopify_customers c
        INNER JOIN name_scope ns
          ON lower(trim(coalesce(c.sp_assigned, ''))) = ns.owner_name
          OR lower(trim(coalesce(c.referred_by, ''))) = ns.owner_name
        UNION
        SELECT DISTINCT
          es.customer_id,
          es.shopify_customer_id
        FROM explicit_scope es
      ),
      candidate_orders_direct AS (
        SELECT DISTINCT o.id
        FROM public.shopify_orders o
        INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
      ),
      candidate_orders_fallback AS (
        SELECT DISTINCT o.id
        FROM public.shopify_orders o
        INNER JOIN scoped_customers sc
          ON o.customer_id IS NULL
          AND o.shopify_customer_id IS NOT NULL
          AND sc.shopify_customer_id IS NOT NULL
          AND o.shopify_customer_id = sc.shopify_customer_id
      ),
      candidate_orders AS (
        SELECT id FROM candidate_orders_direct
        UNION
        SELECT id FROM candidate_orders_fallback
      ),
      filtered AS (
        SELECT o.*
        FROM public.shopify_orders o
        WHERE (
          NOT coalesce($12, true)
          OR EXISTS (SELECT 1 FROM candidate_orders co WHERE co.id = o.id)
        )
          AND (
            coalesce(trim($4), '') = ''
            OR coalesce(o.order_number::text, '') ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
            OR coalesce(o.customer_name, '') ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
          )
          AND (
            coalesce($5, 'all') = 'all'
            OR o.financial_status = $5
          )
          AND (
            coalesce($6, 'all') = 'all'
            OR o.fulfillment_status = $6
          )
          AND ($7 IS NULL OR o.shopify_created_at >= $7)
          AND ($8 IS NULL OR o.shopify_created_at < $8)
      ),
      page_rows AS (
        SELECT
          to_jsonb(f) AS row_data,
          count(*) OVER()::bigint AS total_count
        FROM filtered f
        ORDER BY %I %s NULLS LAST
        OFFSET $9
        LIMIT $10
      )
      SELECT p.row_data, p.total_count
      FROM page_rows p
    $sql$,
    v_sort_col,
    v_sort_dir
  )
  USING
    _viewer_user_id,
    _salesperson_user_ids,
    _owner_names,
    _search,
    _status_filter,
    _fulfillment_filter,
    _from_iso,
    _to_iso,
    v_offset,
    GREATEST(coalesce(_page_size, 15), 1),
    v_sort_col,
    _force_scoped_filter,
    _customer_ids;
END;
$$;


-- Patched from 20260429162000_optimize_scoped_orders_and_order_items_rpcs.sql
CREATE OR REPLACE FUNCTION public.get_scoped_order_items_page(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _owner_names TEXT[] DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _page INTEGER DEFAULT 1,
  _page_size INTEGER DEFAULT 500,
  _force_scoped_filter BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  row_data JSONB,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_offset INTEGER;
BEGIN
  IF _viewer_user_id IS NULL THEN
    RAISE EXCEPTION 'viewer user id is required';
  END IF;

  IF auth.uid() IS NULL OR (auth.uid() <> _viewer_user_id AND NOT public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  v_offset := GREATEST(coalesce(_page, 1), 1) - 1;
  v_offset := v_offset * GREATEST(coalesce(_page_size, 500), 1);

  RETURN QUERY
  WITH name_scope AS (
    SELECT DISTINCT lower(trim(nm)) AS owner_name
    FROM unnest(coalesce(_owner_names, ARRAY[]::text[])) nm
    WHERE coalesce(trim(nm), '') <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.shopify_customers c
    WHERE EXISTS (
      SELECT 1
      FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids) t
      WHERE t.customer_id = c.id
    )
    UNION
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.shopify_customers c
    INNER JOIN name_scope ns
      ON lower(trim(coalesce(c.sp_assigned, ''))) = ns.owner_name
      OR lower(trim(coalesce(c.referred_by, ''))) = ns.owner_name
  ),
  candidate_orders_direct AS (
    SELECT DISTINCT o.id, o.order_number, o.shopify_created_at, o.currency_code
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
  ),
  candidate_orders_fallback AS (
    SELECT DISTINCT o.id, o.order_number, o.shopify_created_at, o.currency_code
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
  ),
  candidate_orders AS (
    SELECT * FROM candidate_orders_direct
    UNION
    SELECT * FROM candidate_orders_fallback
  ),
  scoped_orders AS (
    SELECT
      o.id,
      o.order_number,
      o.shopify_created_at,
      o.currency_code
    FROM public.shopify_orders o
    WHERE (
      NOT coalesce(_force_scoped_filter, true)
      OR EXISTS (SELECT 1 FROM candidate_orders co WHERE co.id = o.id)
    )
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
  ),
  filtered AS (
    SELECT
      so.id AS order_id,
      so.order_number,
      so.shopify_created_at,
      so.currency_code,
      oi.product,
      oi.variant,
      oi.sku,
      oi.quantity,
      oi.price
    FROM scoped_orders so
    INNER JOIN public.shopify_order_items oi ON oi.order_id = so.id
  ),
  page_rows AS (
    SELECT
      to_jsonb(f) AS row_data,
      count(*) OVER()::bigint AS total_count
    FROM filtered f
    ORDER BY f.shopify_created_at DESC NULLS LAST, f.order_id DESC
    OFFSET v_offset
    LIMIT GREATEST(coalesce(_page_size, 500), 1)
  )
  SELECT p.row_data, p.total_count
  FROM page_rows p;
END;
$$;


-- Patched from 20260430195500_add_analytics_overview_rfm_rpcs.sql
CREATE OR REPLACE FUNCTION public.get_analytics_overview_kpis(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  active_buyers_count BIGINT,
  registrations_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
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
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id, c.shopify_created_at
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id, c.shopify_created_at
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
  active_buyers AS (
    SELECT count(DISTINCT sc.customer_id)::bigint AS count_active
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
  registrations AS (
    SELECT count(DISTINCT sc.customer_id)::bigint AS count_reg
    FROM scoped_customers sc
    WHERE (_from_iso IS NULL OR sc.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR sc.shopify_created_at < _to_iso)
  )
  SELECT
    coalesce((SELECT count_active FROM active_buyers), 0)::bigint AS active_buyers_count,
    coalesce((SELECT count_reg FROM registrations), 0)::bigint AS registrations_count;
$$;


-- Patched from 20260430195500_add_analytics_overview_rfm_rpcs.sql
CREATE OR REPLACE FUNCTION public.get_analytics_rfm_group_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  rfm_group TEXT,
  customers_count BIGINT,
  active_buyers_count BIGINT,
  revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
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
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id, coalesce(c.rfm_group, 'Unclassified') AS rfm_group
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id, coalesce(c.rfm_group, 'Unclassified') AS rfm_group
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
      sc.customer_id,
      sc.rfm_group,
      coalesce(o.total, 0)::numeric(14,2) AS total
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
  all_groups AS (
    SELECT
      sc.rfm_group,
      count(DISTINCT sc.customer_id)::bigint AS customers_count
    FROM scoped_customers sc
    GROUP BY sc.rfm_group
  ),
  active_groups AS (
    SELECT
      so.rfm_group,
      count(DISTINCT so.customer_id)::bigint AS active_buyers_count,
      coalesce(sum(so.total), 0)::numeric(14,2) AS revenue
    FROM scoped_orders so
    GROUP BY so.rfm_group
  )
  SELECT
    ag.rfm_group::text,
    ag.customers_count,
    coalesce(act.active_buyers_count, 0)::bigint AS active_buyers_count,
    coalesce(act.revenue, 0)::numeric(14,2) AS revenue
  FROM all_groups ag
  LEFT JOIN active_groups act ON act.rfm_group = ag.rfm_group
  ORDER BY ag.customers_count DESC, ag.rfm_group ASC;
$$;


-- Patched from 20260430192500_fix_analytics_scope_performance_rows_500.sql
CREATE OR REPLACE FUNCTION public.get_analytics_scope_performance_rows(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _role_filter TEXT DEFAULT 'all'
)
RETURNS TABLE (
  viewer_user_id UUID,
  viewer_name TEXT,
  viewer_role public.app_role,
  team_member_count BIGINT,
  team_customers_count BIGINT,
  team_orders_count BIGINT,
  team_revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  WITH authz AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (auth.uid() = _viewer_user_id) AS is_self
  ),
  allowed_viewers AS (
    SELECT v.viewer_user_id
    FROM public.v_user_scope_performance v
    CROSS JOIN authz a
    WHERE a.is_admin
    UNION
    SELECT DISTINCT unnest(
      coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])
    ) AS viewer_user_id
    FROM authz a
    WHERE NOT a.is_admin AND a.is_self
    UNION
    SELECT _viewer_user_id
    FROM authz a
    WHERE NOT a.is_admin AND a.is_self
  ),
  role_names AS (
    SELECT
      ur.user_id,
      max(NULLIF(btrim(ur.salesperson_name), '')) AS role_display_name
    FROM public.user_roles ur
    GROUP BY ur.user_id
  ),
  base AS (
    SELECT
      v.viewer_user_id,
      v.viewer_role,
      v.team_member_count
    FROM public.v_user_scope_performance v
    INNER JOIN allowed_viewers av ON av.viewer_user_id = v.viewer_user_id
    WHERE (
      lower(coalesce(_role_filter, 'all')) = 'all'
      OR (lower(_role_filter) = 'manager' AND v.viewer_role = 'manager')
      OR (lower(_role_filter) = 'supervisor' AND v.viewer_role = 'supervisor')
    )
  )
  SELECT
    b.viewer_user_id,
    coalesce(
      rn.role_display_name,
      b.viewer_user_id::text
    )::text AS viewer_name,
    b.viewer_role,
    b.team_member_count,
    coalesce(m.customers_count, 0)::bigint AS team_customers_count,
    coalesce(m.orders_count, 0)::bigint AS team_orders_count,
    coalesce(m.revenue, 0)::numeric(14,2) AS team_revenue
  FROM base b
  LEFT JOIN role_names rn ON rn.user_id = b.viewer_user_id
  LEFT JOIN LATERAL public.get_scope_order_metrics(
    b.viewer_user_id,
    _from_iso,
    _to_iso
  ) m ON true
  ORDER BY team_revenue DESC, viewer_name ASC;
$$;


-- Patched from 20260430173000_add_analytics_report_aggregation_rpcs.sql
CREATE OR REPLACE FUNCTION public.get_analytics_top_products(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  product_name TEXT,
  units_sold BIGINT,
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
    SELECT DISTINCT o.id
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
  )
  SELECT
    coalesce(
      nullif(
        concat_ws(' - ', nullif(trim(oi.product), ''), nullif(trim(oi.variant), '')),
        ''
      ),
      'Item'
    )::text AS product_name,
    coalesce(sum(coalesce(oi.quantity, 0)), 0)::bigint AS units_sold,
    coalesce(sum(coalesce(oi.quantity, 0) * coalesce(oi.price, 0)), 0)::numeric(14,2) AS revenue
  FROM public.shopify_order_items oi
  INNER JOIN scoped_orders so ON so.id = oi.order_id
  GROUP BY 1
  ORDER BY revenue DESC, product_name ASC;
$$;


-- Patched from 20260430173000_add_analytics_report_aggregation_rpcs.sql
CREATE OR REPLACE FUNCTION public.get_analytics_top_customers(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  customer_label TEXT,
  customer_email TEXT,
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
      o.customer_id,
      o.shopify_customer_id,
      o.customer_name,
      o.email,
      coalesce(o.total, 0)::numeric AS total
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
  )
  SELECT
    coalesce(
      nullif(max(nullif(btrim(coalesce(so.customer_name, '')), '')), ''),
      nullif(max(nullif(btrim(coalesce(so.email, '')), '')), ''),
      'Guest'
    )::text AS customer_label,
    coalesce(nullif(max(nullif(btrim(coalesce(so.email, '')), '')), ''), '')::text AS customer_email,
    count(*)::bigint AS orders_count,
    coalesce(sum(so.total), 0)::numeric(14,2) AS revenue
  FROM scoped_orders so
  GROUP BY coalesce(
    CASE WHEN so.customer_id IS NOT NULL THEN 'id:' || so.customer_id::text ELSE NULL END,
    CASE WHEN so.shopify_customer_id IS NOT NULL THEN 'sid:' || so.shopify_customer_id::text ELSE NULL END,
    CASE WHEN so.email IS NOT NULL AND btrim(so.email) <> '' THEN 'em:' || lower(trim(so.email)) ELSE NULL END,
    CASE WHEN so.customer_name IS NOT NULL AND btrim(so.customer_name) <> '' THEN 'nm:' || btrim(so.customer_name) ELSE NULL END,
    'guest:no-detail'
  )
  ORDER BY revenue DESC, customer_label ASC;
$$;


-- Patched from 20260430173000_add_analytics_report_aggregation_rpcs.sql
CREATE OR REPLACE FUNCTION public.get_analytics_payment_status_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  payment_status TEXT,
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
      coalesce(o.financial_status, 'unknown') AS financial_status,
      coalesce(o.total, 0)::numeric AS total
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
  )
  SELECT
    financial_status::text AS payment_status,
    count(*)::bigint AS orders_count,
    coalesce(sum(total), 0)::numeric(14,2) AS revenue
  FROM scoped_orders
  GROUP BY financial_status
  ORDER BY revenue DESC, payment_status ASC;
$$;


-- Patched from 20260430173000_add_analytics_report_aggregation_rpcs.sql
CREATE OR REPLACE FUNCTION public.get_analytics_fulfillment_status_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  fulfillment_status TEXT,
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
      coalesce(o.fulfillment_status, 'unknown') AS fulfillment_status,
      coalesce(o.total, 0)::numeric AS total
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
  )
  SELECT
    fulfillment_status::text AS fulfillment_status,
    count(*)::bigint AS orders_count,
    coalesce(sum(total), 0)::numeric(14,2) AS revenue
  FROM scoped_orders
  GROUP BY fulfillment_status
  ORDER BY revenue DESC, fulfillment_status ASC;
$$;


-- Patched from 20260430173000_add_analytics_report_aggregation_rpcs.sql
CREATE OR REPLACE FUNCTION public.get_analytics_tax_summary_rows(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  breakdown TEXT,
  currency_code TEXT,
  subtotal NUMERIC(14,2),
  tax NUMERIC(14,2),
  total NUMERIC(14,2)
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
  scoped_orders AS (
    SELECT DISTINCT
      o.id,
      coalesce(o.currency_code, 'GBP')::text AS currency_code,
      coalesce(o.subtotal, 0)::numeric AS subtotal,
      coalesce(o.total_tax, 0)::numeric AS total_tax,
      coalesce(o.total, 0)::numeric AS total
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
  by_currency AS (
    SELECT
      currency_code,
      coalesce(sum(subtotal), 0)::numeric(14,2) AS subtotal,
      coalesce(sum(total_tax), 0)::numeric(14,2) AS tax,
      coalesce(sum(total), 0)::numeric(14,2) AS total
    FROM scoped_orders
    GROUP BY currency_code
  ),
  total_all AS (
    SELECT
      coalesce(sum(subtotal), 0)::numeric(14,2) AS subtotal,
      coalesce(sum(tax), 0)::numeric(14,2) AS tax,
      coalesce(sum(total), 0)::numeric(14,2) AS total
    FROM by_currency
  )
  SELECT x.breakdown, x.currency_code, x.subtotal, x.tax, x.total
  FROM (
    SELECT
      0::int AS sort_rank,
      'All currencies combined'::text AS breakdown,
      '—'::text AS currency_code,
      ta.subtotal,
      ta.tax,
      ta.total
    FROM total_all ta
    UNION ALL
    SELECT
      1::int AS sort_rank,
      ('Currency: ' || bc.currency_code)::text AS breakdown,
      bc.currency_code,
      bc.subtotal,
      bc.tax,
      bc.total
    FROM by_currency bc
  ) x
  ORDER BY x.sort_rank, x.breakdown;
$$;


-- Patched from 20260430173000_add_analytics_report_aggregation_rpcs.sql
CREATE OR REPLACE FUNCTION public.get_analytics_sales_by_salesperson(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  salesperson_name TEXT,
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
      coalesce(o.total, 0)::numeric AS total,
      coalesce(o.customer_id, sc.customer_id) AS customer_id_resolved
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
  order_attribution AS (
    SELECT
      so.id AS order_id,
      so.total,
      coalesce(att.salesperson_name, 'Unassigned')::text AS salesperson_name
    FROM scoped_orders so
    LEFT JOIN LATERAL (
      SELECT DISTINCT vsca.salesperson_name
      FROM public.v_salesperson_customer_attribution vsca
      WHERE vsca.customer_id = so.customer_id_resolved
    ) att ON true
  )
  SELECT
    oa.salesperson_name,
    count(DISTINCT oa.order_id)::bigint AS orders_count,
    coalesce(sum(oa.total), 0)::numeric(14,2) AS revenue
  FROM order_attribution oa
  GROUP BY oa.salesperson_name
  ORDER BY revenue DESC, oa.salesperson_name ASC;
$$;


-- Patched from 20260601081000_fix_supervisor_manager_self_performance_name_fallback.sql
CREATE OR REPLACE FUNCTION public.get_supervisor_manager_self_performance_row(
  _supervisor_user_id UUID,
  _manager_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  manager_user_id UUID,
  manager_name TEXT,
  customers_count BIGINT,
  orders_count BIGINT,
  revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH authz AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (auth.uid() = _supervisor_user_id AND public.has_role(auth.uid(), 'supervisor')) AS is_self_supervisor
  ),
  allowed_manager AS (
    SELECT _manager_user_id AS manager_user_id
    FROM authz a
    WHERE a.is_admin
       OR (
         a.is_self_supervisor
         AND EXISTS (
           SELECT 1
           FROM public.sales_hierarchy_edges e
           WHERE e.leader_user_id = _supervisor_user_id
             AND e.leader_role = 'supervisor'
             AND e.member_user_id = _manager_user_id
         )
       )
  ),
  manager_name AS (
    SELECT
      am.manager_user_id,
      coalesce(
        nullif(
          btrim((
            SELECT max(ur.salesperson_name)
            FROM public.user_roles ur
            WHERE ur.user_id = am.manager_user_id
              AND ur.salesperson_name IS NOT NULL
              AND btrim(ur.salesperson_name) <> ''
          )),
          ''
        ),
        nullif(btrim(coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', '')), ''),
        split_part(coalesce(au.email, ''), '@', 1),
        am.manager_user_id::text
      )::text AS manager_name
    FROM allowed_manager am
    LEFT JOIN auth.users au ON au.id = am.manager_user_id
  ),
  manager_scope_names AS (
    SELECT DISTINCT lower(trim(ur.salesperson_name)) AS salesperson_name_norm
    FROM allowed_manager am
    INNER JOIN public.user_roles ur
      ON ur.user_id = am.manager_user_id
    WHERE ur.salesperson_name IS NOT NULL
      AND btrim(ur.salesperson_name) <> ''
  ),
  manager_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
    FROM allowed_manager am
    INNER JOIN public.salesperson_customer_assignments a
      ON a.salesperson_user_id = am.manager_user_id
    INNER JOIN public.shopify_customers c
      ON c.id = a.customer_id
    WHERE (_from_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) < _to_iso)
    UNION
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    WHERE (_from_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) < _to_iso)
      AND EXISTS (
        SELECT 1
        FROM manager_scope_names msn
        WHERE msn.salesperson_name_norm = lower(trim(coalesce(c.sp_assigned, '')))
           OR msn.salesperson_name_norm = lower(trim(coalesce(c.referred_by, '')))
      )
  ),
  manager_orders AS (
    SELECT DISTINCT
      o.id AS order_id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric
      END AS order_amount
    FROM public.shopify_orders o
    INNER JOIN manager_customers mc
      ON o.customer_id = mc.customer_id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND mc.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = mc.shopify_customer_id
      )
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
      AND coalesce(o.test_order, false) = false
  )
  SELECT
    mn.manager_user_id,
    mn.manager_name,
    coalesce((SELECT count(*)::bigint FROM manager_customers), 0) AS customers_count,
    coalesce((SELECT count(*)::bigint FROM manager_orders), 0) AS orders_count,
    coalesce((SELECT sum(mo.order_amount) FROM manager_orders mo), 0)::numeric(14,2) AS revenue
  FROM manager_name mn;
$$;


-- Patched from 20260430143000_refine_supervisor_manager_scope_to_manager_nodes.sql
CREATE OR REPLACE FUNCTION public.get_supervisor_manager_scope_scorecards(
  _supervisor_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  viewer_user_id UUID,
  viewer_role public.app_role,
  team_member_count BIGINT,
  team_customers_count BIGINT,
  team_orders_count BIGINT,
  team_revenue NUMERIC(14,2),
  manager_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH manager_scope AS (
    SELECT DISTINCT
      e.member_user_id AS manager_user_id
    FROM public.sales_hierarchy_edges e
    WHERE e.leader_user_id = _supervisor_user_id
      AND e.leader_role = 'supervisor'
      AND (
        EXISTS (
          SELECT 1
          FROM public.user_roles ur
          WHERE ur.user_id = e.member_user_id
            AND ur.role = 'manager'
        )
        OR EXISTS (
          SELECT 1
          FROM public.sales_hierarchy_edges me
          WHERE me.leader_user_id = e.member_user_id
            AND me.leader_role = 'manager'
        )
      )
  ),
  manager_rollup AS (
    SELECT
      ms.manager_user_id AS viewer_user_id,
      'manager'::public.app_role AS viewer_role,
      (
        SELECT count(*)::bigint
        FROM public.sales_hierarchy_edges me
        WHERE me.leader_user_id = ms.manager_user_id
          AND me.leader_role = 'manager'
      ) AS team_member_count,
      coalesce(m.customers_count, 0)::bigint AS team_customers_count,
      coalesce(m.orders_count, 0)::bigint AS team_orders_count,
      coalesce(m.revenue, 0)::numeric(14,2) AS team_revenue
    FROM manager_scope ms
    LEFT JOIN LATERAL public.get_scope_order_metrics(
      ms.manager_user_id,
      _from_iso,
      _to_iso
    ) m ON true
  )
  SELECT
    mr.viewer_user_id,
    mr.viewer_role,
    mr.team_member_count,
    mr.team_customers_count,
    mr.team_orders_count,
    mr.team_revenue,
    COALESCE(NULLIF(max(sp.salesperson_name), ''), 'Manager') AS manager_name
  FROM manager_rollup mr
  LEFT JOIN public.user_roles sp
    ON sp.user_id = mr.viewer_user_id
   AND sp.role = 'salesperson'
  WHERE
    public.has_role(auth.uid(), 'admin')
    OR (
      auth.uid() = _supervisor_user_id
      AND public.has_role(auth.uid(), 'supervisor')
    )
  GROUP BY
    mr.viewer_user_id,
    mr.viewer_role,
    mr.team_member_count,
    mr.team_customers_count,
    mr.team_orders_count,
    mr.team_revenue
  ORDER BY mr.team_revenue DESC;
$$;


-- Patched from 20260514100000_voided_orders_zero_revenue.sql
CREATE OR REPLACE FUNCTION public.get_salesperson_performance_rows(
  _leader_user_id UUID DEFAULT NULL,
  _leader_role TEXT DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  salesperson_user_id UUID,
  salesperson_name TEXT,
  customers_count BIGINT,
  orders_count BIGINT,
  revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH salesperson_base AS (
    SELECT
      ur.user_id AS salesperson_user_id,
      COALESCE(NULLIF(max(ur.salesperson_name), ''), 'Salesperson') AS salesperson_name
    FROM public.user_roles ur
    WHERE ur.role = 'salesperson'
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur_leader
        WHERE ur_leader.user_id = ur.user_id
          AND ur_leader.role IN ('manager', 'supervisor', 'admin', 'owner')
      )
    GROUP BY ur.user_id
  ),
  visibility_scope AS (
    SELECT sb.salesperson_user_id, sb.salesperson_name
    FROM salesperson_base sb
    WHERE
      public.has_role(auth.uid(), 'admin')
      OR (
        public.has_role(auth.uid(), 'salesperson')
        AND sb.salesperson_user_id = auth.uid()
      )
      OR (
        _leader_user_id IS NOT NULL
        AND auth.uid() = _leader_user_id
        AND COALESCE(_leader_role, '') IN ('manager', 'supervisor')
        AND (
          (_leader_role = 'manager' AND public.has_role(auth.uid(), 'manager'))
          OR (_leader_role = 'supervisor' AND public.has_role(auth.uid(), 'supervisor'))
        )
        AND sb.salesperson_user_id IN (
          SELECT e.member_user_id
          FROM public.sales_hierarchy_edges e
          WHERE e.leader_user_id = _leader_user_id
            AND e.leader_role::text = _leader_role
        )
      )
      OR (
        public.has_role(auth.uid(), 'supervisor')
        AND COALESCE(_leader_role, '') = 'manager'
        AND _leader_user_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.sales_hierarchy_edges e_sup
          WHERE e_sup.leader_user_id = auth.uid()
            AND e_sup.leader_role::text = 'supervisor'
            AND e_sup.member_user_id = _leader_user_id
        )
        AND sb.salesperson_user_id IN (
          SELECT e_m.member_user_id
          FROM public.sales_hierarchy_edges e_m
          WHERE e_m.leader_user_id = _leader_user_id
            AND e_m.leader_role::text = 'manager'
        )
      )
  ),
  assignment_customers AS (
    SELECT DISTINCT
      a.salesperson_user_id,
      a.customer_id,
      c.shopify_customer_id,
      c.shopify_created_at,
      c.created_at
    FROM public.salesperson_customer_assignments a
    LEFT JOIN public.shopify_customers c ON c.id = a.customer_id
  ),
  customer_rollup AS (
    SELECT
      ac.salesperson_user_id,
      count(DISTINCT ac.customer_id)::bigint AS customers_count
    FROM assignment_customers ac
    WHERE (_from_iso IS NULL OR coalesce(ac.shopify_created_at, ac.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(ac.shopify_created_at, ac.created_at) < _to_iso)
    GROUP BY ac.salesperson_user_id
  ),
  order_matches AS (
    SELECT
      ac.salesperson_user_id,
      o.id AS order_id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.current_total, o.total, 0)::numeric
      END AS total
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o ON o.customer_id = ac.customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
      AND coalesce(o.test_order, false) = false
    UNION
    SELECT
      ac.salesperson_user_id,
      o.id AS order_id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.current_total, o.total, 0)::numeric
      END AS total
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND ac.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = ac.shopify_customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  order_rollup AS (
    SELECT
      om.salesperson_user_id,
      count(DISTINCT om.order_id)::bigint AS orders_count,
      coalesce(sum(om.total), 0)::numeric(14,2) AS revenue
    FROM order_matches om
    GROUP BY om.salesperson_user_id
  )
  SELECT
    v.salesperson_user_id,
    v.salesperson_name,
    coalesce(cr.customers_count, 0) AS customers_count,
    coalesce(orw.orders_count, 0) AS orders_count,
    coalesce(orw.revenue, 0)::numeric(14,2) AS revenue
  FROM visibility_scope v
  LEFT JOIN customer_rollup cr ON cr.salesperson_user_id = v.salesperson_user_id
  LEFT JOIN order_rollup orw ON orw.salesperson_user_id = v.salesperson_user_id
  ORDER BY coalesce(orw.revenue, 0) DESC, v.salesperson_name ASC;
$$;


-- Patched from 20260518140000_admin_order_financial_reconciliation_rpc.sql
CREATE OR REPLACE FUNCTION public.get_admin_order_financial_reconciliation_candidates(
  _from_iso timestamptz,
  _to_iso timestamptz,
  _only_flagged boolean DEFAULT true,
  _max_rows integer DEFAULT 500
)
RETURNS TABLE (
  order_id uuid,
  shopify_order_id text,
  order_number text,
  shopify_created_at timestamptz,
  financial_status text,
  status_norm text,
  total numeric,
  original_total numeric,
  current_total numeric,
  subtotal numeric,
  total_tax numeric,
  eff_orig numeric,
  eff_curr numeric,
  eff_tax numeric,
  crm_refunded_returned_value numeric,
  missing_current_total boolean,
  flag_reasons text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH params AS (
    SELECT least(greatest(coalesce(_max_rows, 500), 1), 2000)::int AS lim
  ),
  base AS (
    SELECT
      o.id AS order_id,
      o.shopify_order_id,
      o.order_number,
      o.shopify_created_at,
      o.financial_status,
      st.sn AS status_norm,
      o.total::numeric AS total,
      o.original_total::numeric AS original_total,
      o.current_total::numeric AS current_total,
      o.subtotal::numeric AS subtotal,
      o.total_tax::numeric AS total_tax,
      CASE
        WHEN st.sn = 'voided' THEN 0::numeric
        ELSE coalesce(o.original_total, o.total, 0)::numeric
      END AS eff_orig,
      CASE
        WHEN st.sn = 'voided' THEN 0::numeric
        ELSE coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric
      END AS eff_curr,
      CASE
        WHEN st.sn = 'voided' THEN 0::numeric
        ELSE coalesce(o.total_tax, 0)::numeric
      END AS eff_tax,
      CASE
        WHEN st.sn = 'voided' THEN 0::numeric
        ELSE greatest(
          coalesce(o.original_total, o.total, 0)::numeric
          - coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric,
          0::numeric
        )
      END AS crm_refunded_returned_value,
      (o.current_total IS NULL AND st.sn <> 'voided') AS missing_current_total,
      trim(both '; ' FROM concat_ws('; ',
        CASE
          WHEN o.current_total IS NULL AND st.sn <> 'voided' THEN 'missing_current_total'
          ELSE NULL::text
        END,
        CASE
          WHEN st.sn IN ('refunded', 'partially_refunded')
            AND greatest(
              coalesce(o.original_total, o.total, 0)::numeric
              - coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric,
              0::numeric
            ) < 0.02
          THEN 'refunded_status_minimal_refund_slice'
          ELSE NULL::text
        END,
        CASE
          WHEN o.original_total IS NULL
            AND o.total IS NOT NULL
            AND o.current_total IS NOT NULL
            AND abs(o.total::numeric - o.current_total::numeric) > 0.02
          THEN 'original_total_null_total_vs_current_differ'
          ELSE NULL::text
        END,
        CASE
          WHEN st.sn = 'voided'
            AND (
              coalesce(o.total, 0) <> 0
              OR coalesce(o.current_total, 0) <> 0
              OR coalesce(o.original_total, 0) <> 0
            )
          THEN 'voided_row_nonzero_amounts'
          ELSE NULL::text
        END,
        CASE
          WHEN st.sn <> 'voided'
            AND coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric
              > coalesce(o.original_total, o.total, 0)::numeric + 0.02
          THEN 'current_total_exceeds_effective_original'
          ELSE NULL::text
        END
      )) AS flag_reasons
    FROM public.shopify_orders o
    CROSS JOIN LATERAL (SELECT public.normalize_financial_status(o.financial_status) AS sn) st
    WHERE public.has_role(auth.uid(), 'admin')
      AND _from_iso IS NOT NULL
      AND _to_iso IS NOT NULL
      AND o.shopify_created_at >= _from_iso
      AND o.shopify_created_at < _to_iso
      AND coalesce(o.test_order, false) = false
  ),
  ranked AS (
    SELECT b.*
    FROM base b
    WHERE (NOT _only_flagged OR (b.flag_reasons IS NOT NULL AND btrim(b.flag_reasons) <> ''))
    ORDER BY
      CASE WHEN btrim(b.flag_reasons) <> '' THEN 0 ELSE 1 END,
      (b.crm_refunded_returned_value + abs(b.eff_orig - b.eff_curr)) DESC,
      b.shopify_created_at DESC
    LIMIT (SELECT lim FROM params)
  )
  SELECT
    ranked.order_id,
    ranked.shopify_order_id,
    ranked.order_number,
    ranked.shopify_created_at,
    ranked.financial_status,
    ranked.status_norm,
    ranked.total,
    ranked.original_total,
    ranked.current_total,
    ranked.subtotal,
    ranked.total_tax,
    ranked.eff_orig,
    ranked.eff_curr,
    ranked.eff_tax,
    ranked.crm_refunded_returned_value,
    ranked.missing_current_total,
    ranked.flag_reasons
  FROM ranked;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_order_financial_reconciliation_candidates(timestamptz, timestamptz, boolean, integer)
  TO authenticated, service_role;
