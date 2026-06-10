-- Shopify Total sales breakdown parity: Return fees row + total sales formula.
-- Shopify: Total sales = Net sales + Shipping charges − Return fees + Taxes

ALTER TABLE public.shopify_refund_events
  ADD COLUMN IF NOT EXISTS return_fees NUMERIC(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.shopify_refund_events.return_fees IS
  'Shopify Analytics return fees retained on refunds (processed_at attribution).';

CREATE OR REPLACE FUNCTION public.shopify_refund_fees_from_json(_refund jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT round(coalesce((
    SELECT sum(greatest(coalesce((a->>'amount')::numeric, 0), 0))
    FROM jsonb_array_elements(coalesce(_refund->'order_adjustments', '[]'::jsonb)) a
    WHERE lower(coalesce(a->>'kind', '')) LIKE '%return%fee%'
       OR lower(coalesce(a->>'reason', '')) LIKE '%return%fee%'
  ), 0)::numeric, 2);
$$;

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
    AND (_to_iso IS NULL OR re.processed_at <= _to_iso);
$$;

DROP FUNCTION IF EXISTS public.get_scope_shopify_sales_breakdown(uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.get_selected_salespeople_shopify_sales_breakdown(uuid, uuid[], timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.get_scope_shopify_analytics_dashboard(uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.get_selected_salespeople_shopify_analytics_dashboard(uuid, uuid[], timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.get_scope_shopify_sales_breakdown_for_viewers(uuid[], timestamptz, timestamptz);

-- Patch breakdown RPCs: add return_fees column; total = net + ship - return_fees + tax
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
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
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
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) <= _to_iso)
    UNION ALL
    SELECT o.id, o.financial_status, o.subtotal, o.reporting_line_items_gross,
      o.reporting_original_total_discounts, o.reporting_total_discounts, o.reporting_total_shipping
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL AND o.shopify_customer_id = sc.shopify_customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) <= _to_iso)
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
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
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
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
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

GRANT EXECUTE ON FUNCTION public.shopify_refund_fees_from_json(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_analytics_return_fees_for_scope(timestamptz, timestamptz, uuid[]) TO authenticated, service_role;

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

GRANT EXECUTE ON FUNCTION public.get_scope_shopify_sales_breakdown(uuid, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_selected_salespeople_shopify_sales_breakdown(uuid, uuid[], timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_scope_shopify_analytics_dashboard(uuid, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_selected_salespeople_shopify_analytics_dashboard(uuid, uuid[], timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_scope_shopify_sales_breakdown_for_viewers(uuid[], timestamptz, timestamptz) TO authenticated, service_role;
