-- Keep scope RPC behavior aligned with expanded leader visibility rules.
-- Includes both identity assignments and scoped ownership-name fallback.

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
  sums AS (
    SELECT
      count(*)::bigint AS c_orders,
      coalesce(sum(total), 0)::numeric(14,2) AS c_revenue
    FROM scoped_orders
  )
  SELECT
    s.c_orders AS orders_count,
    (SELECT count(*)::bigint FROM scoped_customers) AS customers_count,
    s.c_revenue AS revenue,
    CASE
      WHEN s.c_orders > 0 THEN round((s.c_revenue / s.c_orders)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_value
  FROM sums s;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_order_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

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

GRANT EXECUTE ON FUNCTION public.get_scope_order_timeseries(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;
