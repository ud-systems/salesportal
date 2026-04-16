-- Timeseries RPC for manager-selected salesperson scope.
-- Keeps chart filtering server-side and permission-safe.

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
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
  ),
  bucketed AS (
    SELECT
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', o.shopify_created_at), 'YYYY-MM-DD')
        ELSE to_char(date_trunc('month', o.shopify_created_at), 'YYYY-MM')
      END AS bucket_key,
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', o.shopify_created_at), 'DD Mon')
        ELSE to_char(date_trunc('month', o.shopify_created_at), 'Mon YYYY')
      END AS bucket_label,
      count(*)::bigint AS orders_count,
      coalesce(sum(o.total), 0)::numeric(14,2) AS revenue
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

GRANT EXECUTE ON FUNCTION public.get_manager_selected_salespeople_timeseries(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;
