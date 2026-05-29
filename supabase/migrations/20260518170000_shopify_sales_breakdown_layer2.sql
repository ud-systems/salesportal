-- Layer 2: Shopify Analytics–style revenue components (discounts, shipping, refunds, line gross).
-- Ingested from Admin GraphQL on sync/webhook; see edge _shared/shopify-order-reporting.ts.

ALTER TABLE public.shopify_orders
  ADD COLUMN IF NOT EXISTS reporting_line_items_gross NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS reporting_total_discounts NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS reporting_total_shipping NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS reporting_total_refunded NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS taxes_included BOOLEAN;

COMMENT ON COLUMN public.shopify_orders.reporting_line_items_gross IS
  'Σ(originalUnitPrice × qty) from line items at last sync; approximates pre-discount merchandise (Shopify gross-sales basis).';
COMMENT ON COLUMN public.shopify_orders.reporting_total_discounts IS
  'Shopify Order.currentTotalDiscountsSet.shopMoney — discounts after returns/refunds.';
COMMENT ON COLUMN public.shopify_orders.reporting_total_shipping IS
  'Shopify Order.currentShippingPriceSet.shopMoney — shipping after refunds/discounts.';
COMMENT ON COLUMN public.shopify_orders.reporting_total_refunded IS
  'Shopify Order.totalRefundedSet.shopMoney — total refunded (Analytics Returns proxy).';
COMMENT ON COLUMN public.shopify_orders.taxes_included IS
  'Shopify Order.taxesIncluded — whether line/subtotal amounts include tax.';

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
      coalesce(o.reporting_total_refunded, 0)::numeric AS refunded_raw,
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

COMMENT ON FUNCTION public.get_scope_shopify_sales_breakdown(uuid, timestamptz, timestamptz) IS
  'Layer 2: aggregates reporting_* columns + taxes + shipping. net_sales_derived = gross line list − discounts − refunded; total_sales_check adds tax + shipping.';

GRANT EXECUTE ON FUNCTION public.get_scope_shopify_sales_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
