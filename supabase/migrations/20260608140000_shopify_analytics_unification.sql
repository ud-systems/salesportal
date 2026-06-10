-- Shopify Analytics unification: single refund/total-sales rules + unified dashboard RPC.
-- Fixes false refund drift on pending orders (original_total - current_total without real returns).

-- ---------------------------------------------------------------------------
-- Helpers (immutable per order row)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.shopify_order_effective_returns(
  _financial_status text,
  _total numeric,
  _current_total numeric,
  _original_total numeric,
  _reporting_total_refunded numeric
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN public.normalize_financial_status(_financial_status) = 'voided' THEN 0::numeric
    WHEN coalesce(_reporting_total_refunded, 0) > 0 THEN coalesce(_reporting_total_refunded, 0)::numeric
    WHEN public.normalize_financial_status(_financial_status) IN ('refunded', 'partially_refunded') THEN greatest(
      coalesce(_original_total, _total, 0)::numeric
        - coalesce(_current_total, coalesce(_original_total, _total), 0)::numeric,
      0::numeric
    )
    ELSE 0::numeric
  END;
$$;

CREATE OR REPLACE FUNCTION public.shopify_order_effective_total_sales(
  _financial_status text,
  _total numeric,
  _current_total numeric,
  _original_total numeric,
  _reporting_total_refunded numeric
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN public.normalize_financial_status(_financial_status) = 'voided' THEN 0::numeric
    WHEN coalesce(_reporting_total_refunded, 0) > 0
      OR public.normalize_financial_status(_financial_status) IN ('refunded', 'partially_refunded')
    THEN coalesce(_current_total, coalesce(_original_total, _total), 0)::numeric
    ELSE coalesce(_total, _current_total, _original_total, 0)::numeric
  END;
$$;

COMMENT ON FUNCTION public.shopify_order_effective_returns IS
  'Shopify Analytics Returns: reporting_total_refunded, or orig−curr only when status is refunded.';
COMMENT ON FUNCTION public.shopify_order_effective_total_sales IS
  'Shopify Analytics Total sales per order: totalPriceSet for pending (no returns); current after real refunds.';

-- Backfill: pending/authorized orders with false current_total drops (no Shopify return signal).
UPDATE public.shopify_orders o
SET
  current_total = o.total,
  updated_at = now()
WHERE coalesce(o.test_order, false) = false
  AND public.normalize_financial_status(o.financial_status) IN ('pending', 'authorized')
  AND coalesce(o.reporting_total_refunded, 0) = 0
  AND o.total IS NOT NULL
  AND o.current_total IS NOT NULL
  AND o.current_total < o.total;

-- ---------------------------------------------------------------------------
-- Unified dashboard RPC (Shopify Analytics naming)
-- ---------------------------------------------------------------------------

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
    fin.current_gross_sales AS total_sales,
    fin.orders_total_count AS orders_total,
    fin.orders_paid_count AS orders_paid,
    fin.orders_pending_count AS orders_pending,
    fin.orders_refunded_count AS orders_refunded,
    u.c AS orders_unfulfilled,
    fin.customers_count,
    CASE
      WHEN fin.orders_total_count > 0 THEN round((fin.current_gross_sales / fin.orders_total_count)::numeric, 2)
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
    fin.current_gross_sales AS total_sales,
    fin.orders_total_count AS orders_total,
    fin.orders_paid_count AS orders_paid,
    fin.orders_pending_count AS orders_pending,
    fin.orders_refunded_count AS orders_refunded,
    u.c AS orders_unfulfilled,
    fin.customers_count,
    CASE
      WHEN fin.orders_total_count > 0 THEN round((fin.current_gross_sales / fin.orders_total_count)::numeric, 2)
      ELSE 0::numeric
    END AS average_order_value,
    bd.orders_missing_reporting
  FROM bd
  CROSS JOIN fin
  CROSS JOIN unfulfilled u;
$$;

GRANT EXECUTE ON FUNCTION public.shopify_order_effective_returns(text, numeric, numeric, numeric, numeric)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_order_effective_total_sales(text, numeric, numeric, numeric, numeric)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_scope_shopify_analytics_dashboard(uuid, timestamptz, timestamptz)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_selected_salespeople_shopify_analytics_dashboard(uuid, uuid[], timestamptz, timestamptz)
  TO authenticated, service_role;
