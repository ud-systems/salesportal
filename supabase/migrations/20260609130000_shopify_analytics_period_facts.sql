-- Store-level Shopify Analytics facts (ShopifyQL sales events by Dubai day).
-- Admin breakdown uses these when every day in the selected period is synced.

CREATE TABLE IF NOT EXISTS public.shopify_analytics_period_facts (
  reporting_day date PRIMARY KEY,
  gross_sales numeric(14,2) NOT NULL DEFAULT 0,
  discounts numeric(14,2) NOT NULL DEFAULT 0,
  returns_refunded numeric(14,2) NOT NULL DEFAULT 0,
  net_sales numeric(14,2) NOT NULL DEFAULT 0,
  shipping_charges numeric(14,2) NOT NULL DEFAULT 0,
  return_fees numeric(14,2) NOT NULL DEFAULT 0,
  taxes numeric(14,2) NOT NULL DEFAULT 0,
  total_sales numeric(14,2) NOT NULL DEFAULT 0,
  orders_count bigint NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.shopify_analytics_period_facts IS
  'Daily store-level Shopify Analytics totals from ShopifyQL (sales event day, Asia/Dubai).';

ALTER TABLE public.shopify_analytics_period_facts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shopify_analytics_period_facts_service_role ON public.shopify_analytics_period_facts;
CREATE POLICY shopify_analytics_period_facts_service_role ON public.shopify_analytics_period_facts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON public.shopify_analytics_period_facts TO authenticated;
GRANT ALL ON public.shopify_analytics_period_facts TO service_role;

CREATE OR REPLACE FUNCTION public.shopify_reporting_days_in_period(
  _from_iso timestamptz,
  _to_iso timestamptz
)
RETURNS SETOF date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT gs::date
  FROM generate_series(
    public.shopify_reporting_day_bucket(_from_iso)::date,
    public.shopify_reporting_day_bucket((_to_iso - interval '1 microsecond'))::date,
    interval '1 day'
  ) AS gs
  WHERE _from_iso IS NOT NULL
    AND _to_iso IS NOT NULL
    AND _from_iso < _to_iso;
$$;

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
  WITH expected AS (
    SELECT count(*)::bigint AS cnt
    FROM public.shopify_reporting_days_in_period(_from_iso, _to_iso) d
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
    FROM public.shopify_analytics_period_facts f
    WHERE (_from_iso IS NULL OR f.reporting_day >= public.shopify_reporting_day_bucket(_from_iso)::date)
      AND (_to_iso IS NULL OR f.reporting_day < public.shopify_reporting_day_bucket(_to_iso)::date)
      AND (_from_iso IS NOT NULL AND _to_iso IS NOT NULL)
      AND f.reporting_day IN (SELECT d FROM public.shopify_reporting_days_in_period(_from_iso, _to_iso) d)
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

GRANT EXECUTE ON FUNCTION public.shopify_reporting_days_in_period(timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_analytics_store_period_rollup(timestamptz, timestamptz) TO authenticated, service_role;

-- Admin breakdown: prefer complete store-level ShopifyQL period facts (sales event day).
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
