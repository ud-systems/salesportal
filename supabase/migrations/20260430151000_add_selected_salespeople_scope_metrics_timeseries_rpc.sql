-- Consolidate selected-salespeople scoped metrics and timeseries into one RPC
-- to replace frontend fanout/chunk aggregation paths.

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
  gross_revenue NUMERIC(14,2),
  refunded_amount NUMERIC(14,2),
  net_revenue NUMERIC(14,2),
  avg_order_gross NUMERIC(14,2),
  avg_order_net NUMERIC(14,2),
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
      AND (_to_iso IS NULL OR customer_created_at <= _to_iso)
  ),
  order_matches AS (
    SELECT
      o.id,
      coalesce(o.total, 0)::numeric AS total,
      lower(trim(coalesce(o.financial_status, ''))) AS financial_status_norm,
      coalesce(o.shopify_created_at, o.created_at) AS order_created_at
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) <= _to_iso)

    UNION

    SELECT
      o.id,
      coalesce(o.total, 0)::numeric AS total,
      lower(trim(coalesce(o.financial_status, ''))) AS financial_status_norm,
      coalesce(o.shopify_created_at, o.created_at) AS order_created_at
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
    SELECT DISTINCT ON (id)
      id,
      total,
      CASE
        WHEN financial_status_norm = 'partially paid' THEN 'partially_paid'
        WHEN financial_status_norm = 'partially refunded' THEN 'partially_refunded'
        WHEN financial_status_norm = '' THEN 'pending'
        ELSE financial_status_norm
      END AS financial_status_norm,
      order_created_at
    FROM order_matches
    ORDER BY id
  ),
  order_agg AS (
    SELECT
      count(*)::bigint AS orders_total_count,
      coalesce(sum(total), 0)::numeric(14,2) AS gross_revenue,
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
          THEN to_char(date_trunc('day', order_created_at), 'YYYY-MM-DD')
        ELSE to_char(date_trunc('month', order_created_at), 'YYYY-MM')
      END AS bucket_key,
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', order_created_at), 'DD Mon')
        ELSE to_char(date_trunc('month', order_created_at), 'Mon YYYY')
      END AS bucket_label,
      count(*)::bigint AS orders_count,
      coalesce(sum(total), 0)::numeric(14,2) AS revenue
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
    oa.gross_revenue AS revenue,
    CASE
      WHEN oa.orders_total_count > 0 THEN round((oa.gross_revenue / oa.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_value,
    oa.orders_total_count,
    oa.orders_paid_count,
    greatest(oa.orders_total_count - oa.orders_paid_count - oa.orders_refunded_count, 0)::bigint AS orders_pending_count,
    oa.orders_refunded_count,
    oa.gross_revenue,
    coalesce(
      (
        SELECT sum(total)::numeric(14,2)
        FROM scoped_orders
        WHERE financial_status_norm IN ('refunded', 'partially_refunded', 'voided')
      ),
      0::numeric(14,2)
    ) AS refunded_amount,
    (
      oa.gross_revenue
      - coalesce(
          (
            SELECT sum(total)::numeric(14,2)
            FROM scoped_orders
            WHERE financial_status_norm IN ('refunded', 'partially_refunded', 'voided')
          ),
          0::numeric(14,2)
        )
    )::numeric(14,2) AS net_revenue,
    CASE
      WHEN oa.orders_total_count > 0 THEN round((oa.gross_revenue / oa.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_gross,
    CASE
      WHEN oa.orders_total_count > 0 THEN round((
        (
          oa.gross_revenue
          - coalesce(
              (
                SELECT sum(total)::numeric(14,2)
                FROM scoped_orders
                WHERE financial_status_norm IN ('refunded', 'partially_refunded', 'voided')
              ),
              0::numeric(14,2)
            )
        ) / oa.orders_total_count
      )::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net,
    sj.series
  FROM order_agg oa
  CROSS JOIN series_json sj;
$$;

GRANT EXECUTE ON FUNCTION public.get_selected_salespeople_scope_metrics_timeseries(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT)
TO authenticated, service_role;
