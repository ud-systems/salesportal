-- Align Shopify Analytics breakdown: subtotal gross, original discounts, refund-date returns.

ALTER TABLE public.shopify_orders
  ADD COLUMN IF NOT EXISTS reporting_original_total_discounts NUMERIC(14,2);

COMMENT ON COLUMN public.shopify_orders.reporting_original_total_discounts IS
  'Shopify Order.totalDiscountsSet at sync — discounts at order creation (Analytics alignment).';

CREATE TABLE IF NOT EXISTS public.shopify_order_refund_deltas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.shopify_orders(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopify_order_refund_deltas_recorded_at
  ON public.shopify_order_refund_deltas(recorded_at);

CREATE INDEX IF NOT EXISTS idx_shopify_order_refund_deltas_order_id
  ON public.shopify_order_refund_deltas(order_id);

ALTER TABLE public.shopify_order_refund_deltas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view refund deltas"
  ON public.shopify_order_refund_deltas FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

GRANT SELECT ON public.shopify_order_refund_deltas TO authenticated;
GRANT ALL ON public.shopify_order_refund_deltas TO service_role;

-- Patch breakdown: subtotal gross, original discounts, refund-date returns + in-period order returns.
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
  refund_date_returns AS (
    SELECT coalesce(sum(d.amount), 0)::numeric AS amt
    FROM public.shopify_order_refund_deltas d
    INNER JOIN scoped_order_ids s ON s.id = d.order_id
    INNER JOIN public.shopify_orders o ON o.id = d.order_id
    WHERE (_from_iso IS NULL OR d.recorded_at >= _from_iso)
      AND (_to_iso IS NULL OR d.recorded_at <= _to_iso)
      AND (
        _from_iso IS NULL OR _to_iso IS NULL
        OR o.shopify_created_at < _from_iso
        OR o.shopify_created_at > _to_iso
      )
  ),
  lines AS (
    SELECT
      o.id o_id,
      public.normalize_financial_status(o.financial_status) AS st,
      coalesce(o.subtotal, o.reporting_line_items_gross, 0)::numeric AS line_gross_raw,
      coalesce(
        o.reporting_original_total_discounts,
        o.reporting_total_discounts,
        0
      )::numeric AS disc_raw,
      coalesce(o.reporting_total_shipping, 0)::numeric AS ship_raw,
      greatest(
        coalesce(o.reporting_total_refunded, 0)::numeric,
        public.shopify_order_effective_returns(
          o.financial_status,
          o.total,
          o.current_total,
          o.original_total,
          o.reporting_total_refunded
        )
      ) AS order_returns_raw,
      coalesce(o.total_tax, 0)::numeric AS tax_raw,
      o.subtotal AS r_subtotal,
      o.reporting_line_items_gross AS r_gross
    FROM public.shopify_orders o
    INNER JOIN scoped_order_ids s ON s.id = o.id
  ),
  normed AS (
    SELECT
      o_id AS id,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE line_gross_raw END AS line_gross,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE disc_raw END AS disc,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE order_returns_raw END AS order_returns,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE ship_raw END AS ship,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE tax_raw END AS tax_amt,
      (st <> 'voided' AND r_subtotal IS NULL AND r_gross IS NULL) AS missing_row
    FROM lines
  ),
  rolled AS (
    SELECT
      coalesce(sum(line_gross), 0)::numeric AS sum_gross,
      coalesce(sum(disc), 0)::numeric AS sum_disc,
      coalesce(sum(order_returns), 0)::numeric AS sum_order_returns,
      coalesce(sum(ship), 0)::numeric AS sum_ship,
      coalesce(sum(tax_amt), 0)::numeric AS sum_tax,
      count(*)::bigint AS cnt,
      count(*) FILTER (WHERE missing_row)::bigint AS missing_cnt
    FROM normed
  )
  SELECT
    r.sum_gross::numeric(14,2) AS gross_sales_line_list,
    r.sum_disc::numeric(14,2) AS discounts,
  (
    r.sum_order_returns + (SELECT amt FROM refund_date_returns)
  )::numeric(14,2) AS returns_refunded,
    (r.sum_gross - r.sum_disc - r.sum_order_returns - (SELECT amt FROM refund_date_returns))::numeric(14,2) AS net_sales_derived,
    r.sum_ship::numeric(14,2) AS shipping,
    r.sum_tax::numeric(14,2) AS taxes,
    (
      r.sum_gross - r.sum_disc - r.sum_order_returns - (SELECT amt FROM refund_date_returns)
      + r.sum_tax + r.sum_ship
    )::numeric(14,2) AS total_sales_check,
    r.cnt AS orders_in_scope,
    r.missing_cnt AS orders_missing_reporting
  FROM rolled r;
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
    SELECT c.id AS customer_id, c.shopify_customer_id
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
      o.subtotal,
      o.reporting_line_items_gross,
      o.reporting_original_total_discounts,
      o.reporting_total_discounts,
      o.reporting_total_shipping,
      o.reporting_total_refunded,
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
      o.subtotal,
      o.reporting_line_items_gross,
      o.reporting_original_total_discounts,
      o.reporting_total_discounts,
      o.reporting_total_shipping,
      o.reporting_total_refunded,
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
    SELECT DISTINCT ON (id) * FROM order_rows ORDER BY id
  ),
  scoped_order_ids AS (
    SELECT id FROM scoped_orders
  ),
  refund_date_returns AS (
    SELECT coalesce(sum(d.amount), 0)::numeric AS amt
    FROM public.shopify_order_refund_deltas d
    INNER JOIN scoped_order_ids s ON s.id = d.order_id
    INNER JOIN public.shopify_orders o ON o.id = d.order_id
    WHERE (_from_iso IS NULL OR d.recorded_at >= _from_iso)
      AND (_to_iso IS NULL OR d.recorded_at <= _to_iso)
      AND (
        _from_iso IS NULL OR _to_iso IS NULL
        OR o.shopify_created_at < _from_iso
        OR o.shopify_created_at > _to_iso
      )
  ),
  lines AS (
    SELECT
      id AS o_id,
      public.normalize_financial_status(financial_status) AS st,
      coalesce(subtotal, reporting_line_items_gross, 0)::numeric AS line_gross_raw,
      coalesce(reporting_original_total_discounts, reporting_total_discounts, 0)::numeric AS disc_raw,
      coalesce(reporting_total_shipping, 0)::numeric AS ship_raw,
      greatest(
        coalesce(reporting_total_refunded, 0)::numeric,
        public.shopify_order_effective_returns(
          financial_status, total, current_total, original_total, reporting_total_refunded
        )
      ) AS order_returns_raw,
      coalesce(total_tax, 0)::numeric AS tax_raw,
      subtotal AS r_subtotal,
      reporting_line_items_gross AS r_gross
    FROM scoped_orders
  ),
  normed AS (
    SELECT
      o_id AS id,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE line_gross_raw END AS line_gross,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE disc_raw END AS disc,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE order_returns_raw END AS order_returns,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE ship_raw END AS ship,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE tax_raw END AS tax_amt,
      (st <> 'voided' AND r_subtotal IS NULL AND r_gross IS NULL) AS missing_row
    FROM lines
  ),
  rolled AS (
    SELECT
      coalesce(sum(line_gross), 0)::numeric AS sum_gross,
      coalesce(sum(disc), 0)::numeric AS sum_disc,
      coalesce(sum(order_returns), 0)::numeric AS sum_order_returns,
      coalesce(sum(ship), 0)::numeric AS sum_ship,
      coalesce(sum(tax_amt), 0)::numeric AS sum_tax,
      count(*)::bigint AS cnt,
      count(*) FILTER (WHERE missing_row)::bigint AS missing_cnt
    FROM normed
  )
  SELECT
    r.sum_gross::numeric(14,2),
    r.sum_disc::numeric(14,2),
    (r.sum_order_returns + (SELECT amt FROM refund_date_returns))::numeric(14,2),
    (r.sum_gross - r.sum_disc - r.sum_order_returns - (SELECT amt FROM refund_date_returns))::numeric(14,2),
    r.sum_ship::numeric(14,2),
    r.sum_tax::numeric(14,2),
    (
      r.sum_gross - r.sum_disc - r.sum_order_returns - (SELECT amt FROM refund_date_returns)
      + r.sum_tax + r.sum_ship
    )::numeric(14,2),
    r.cnt,
    r.missing_cnt
  FROM rolled r;
$$;
