-- 1) Returns: attribute only by refund processed_at (Shopify Analytics), not lifetime order fallback.
-- 2) Shopify Analytics order facts: gross/discounts from ShopifyQL (read_reports) override order subtotal when present.

CREATE TABLE IF NOT EXISTS public.shopify_analytics_order_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id text NOT NULL,
  order_number text,
  reporting_day date NOT NULL,
  gross_sales numeric(14,2) NOT NULL,
  discounts numeric(14,2) NOT NULL DEFAULT 0,
  net_sales numeric(14,2),
  taxes numeric(14,2),
  total_sales numeric(14,2),
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shopify_order_id, reporting_day)
);

CREATE INDEX IF NOT EXISTS shopify_analytics_order_facts_reporting_day_idx
  ON public.shopify_analytics_order_facts (reporting_day);

CREATE INDEX IF NOT EXISTS shopify_analytics_order_facts_order_number_idx
  ON public.shopify_analytics_order_facts (order_number);

COMMENT ON TABLE public.shopify_analytics_order_facts IS
  'Per-order Shopify Analytics sales facts from ShopifyQL (requires read_reports). Overrides subtotal-based gross/discount in breakdown RPCs.';

ALTER TABLE public.shopify_analytics_order_facts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shopify_analytics_order_facts_service_role ON public.shopify_analytics_order_facts;
CREATE POLICY shopify_analytics_order_facts_service_role ON public.shopify_analytics_order_facts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON public.shopify_analytics_order_facts TO authenticated;
GRANT ALL ON public.shopify_analytics_order_facts TO service_role;

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
  )
  SELECT round(
    (SELECT amt FROM refund_event_returns)
    + (SELECT amt FROM refund_delta_returns),
    2
  );
$$;

CREATE OR REPLACE FUNCTION public.shopify_order_reporting_gross(_order_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    (
      SELECT f.gross_sales
      FROM public.shopify_orders o
      INNER JOIN public.shopify_analytics_order_facts f
        ON f.shopify_order_id = o.shopify_order_id
       AND f.reporting_day = public.shopify_reporting_day_bucket(o.shopify_created_at)::date
      WHERE o.id = _order_id
      LIMIT 1
    ),
    (
      SELECT public.shopify_order_analytics_gross(o.subtotal, o.reporting_line_items_gross)
      FROM public.shopify_orders o
      WHERE o.id = _order_id
    ),
    0
  )::numeric;
$$;

CREATE OR REPLACE FUNCTION public.shopify_order_reporting_discount(_order_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    (
      SELECT f.discounts
      FROM public.shopify_orders o
      INNER JOIN public.shopify_analytics_order_facts f
        ON f.shopify_order_id = o.shopify_order_id
       AND f.reporting_day = public.shopify_reporting_day_bucket(o.shopify_created_at)::date
      WHERE o.id = _order_id
      LIMIT 1
    ),
    (
      SELECT public.shopify_order_analytics_discount(
        o.id,
        o.subtotal,
        o.reporting_original_total_discounts,
        o.reporting_total_discounts,
        o.reporting_line_items_gross
      )
      FROM public.shopify_orders o
      WHERE o.id = _order_id
    ),
    0
  )::numeric;
$$;

GRANT EXECUTE ON FUNCTION public.shopify_order_reporting_gross(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_order_reporting_discount(uuid) TO authenticated, service_role;

-- Patch breakdown RPCs to prefer Shopify Analytics facts when synced.
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
      public.shopify_order_reporting_gross(o.id) AS line_gross_raw,
      public.shopify_order_reporting_discount(o.id) AS disc_raw,
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
      public.shopify_order_reporting_gross(id) AS line_gross_raw,
      public.shopify_order_reporting_discount(id) AS disc_raw,
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
