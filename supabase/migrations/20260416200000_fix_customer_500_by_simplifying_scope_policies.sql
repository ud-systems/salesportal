-- Fix customer/orders 500s by removing expensive per-row name-fallback checks in RLS.
-- Keep leader-owned visibility by materializing ownership into assignments first.

-- 1) Materialize ownership from customer fields for any known user name (not only salesperson role).
INSERT INTO public.salesperson_customer_assignments (customer_id, salesperson_user_id, source)
SELECT c.id, ur.user_id, 'sp_assigned_role_agnostic'
FROM public.shopify_customers c
INNER JOIN public.user_roles ur
  ON lower(trim(coalesce(ur.salesperson_name, ''))) = lower(trim(coalesce(c.sp_assigned, '')))
WHERE coalesce(trim(c.sp_assigned), '') NOT IN ('', 'Unassigned', 'unassigned')
  AND coalesce(trim(ur.salesperson_name), '') <> ''
ON CONFLICT (customer_id, salesperson_user_id) DO NOTHING;

INSERT INTO public.salesperson_customer_assignments (customer_id, salesperson_user_id, source)
SELECT c.id, ur.user_id, 'referred_by_role_agnostic'
FROM public.shopify_customers c
INNER JOIN public.user_roles ur
  ON lower(trim(coalesce(ur.salesperson_name, ''))) = lower(trim(coalesce(c.referred_by, '')))
WHERE coalesce(trim(c.referred_by), '') <> ''
  AND coalesce(trim(ur.salesperson_name), '') <> ''
ON CONFLICT (customer_id, salesperson_user_id) DO NOTHING;

-- 2) Recreate fast assignment-based leader policies.
DROP POLICY IF EXISTS "Leaders see scoped customers" ON public.shopify_customers;
CREATE POLICY "Leaders see scoped customers"
  ON public.shopify_customers
  FOR SELECT
  TO authenticated
  USING (
    (
      public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'supervisor')
    )
    AND EXISTS (
      SELECT 1
      FROM public.salesperson_customer_assignments a
      WHERE a.customer_id = shopify_customers.id
        AND a.salesperson_user_id = ANY(
          coalesce(
            public.get_user_scope_user_ids(auth.uid()),
            ARRAY[auth.uid()]::uuid[]
          )
        )
    )
  );

DROP POLICY IF EXISTS "Leaders see scoped orders" ON public.shopify_orders;
CREATE POLICY "Leaders see scoped orders"
  ON public.shopify_orders
  FOR SELECT
  TO authenticated
  USING (
    (
      public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'supervisor')
    )
    AND EXISTS (
      SELECT 1
      FROM public.salesperson_customer_assignments a
      INNER JOIN public.shopify_customers c ON c.id = a.customer_id
      WHERE a.salesperson_user_id = ANY(
        coalesce(
          public.get_user_scope_user_ids(auth.uid()),
          ARRAY[auth.uid()]::uuid[]
        )
      )
      AND (
        shopify_orders.customer_id = c.id
        OR (
          shopify_orders.customer_id IS NULL
          AND shopify_orders.shopify_customer_id IS NOT NULL
          AND c.shopify_customer_id IS NOT NULL
          AND shopify_orders.shopify_customer_id = c.shopify_customer_id
        )
      )
    )
  );

-- 3) Keep scope RPCs aligned to the same fast assignment model.
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
  scoped_customers AS (
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.salesperson_customer_assignments a
    INNER JOIN scope_users su ON su.user_id = a.salesperson_user_id
    INNER JOIN public.shopify_customers c ON c.id = a.customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
  ),
  scoped_orders_non_admin AS (
    SELECT
      o.id,
      coalesce(o.total, 0)::numeric AS total
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
    UNION
    SELECT
      o.id,
      coalesce(o.total, 0)::numeric AS total
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
  ),
  scoped_orders_admin AS (
    SELECT
      o.id,
      coalesce(o.total, 0)::numeric AS total
    FROM public.shopify_orders o
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
  ),
  scoped_orders AS (
    SELECT DISTINCT id, total FROM scoped_orders_admin
    UNION
    SELECT DISTINCT id, total FROM scoped_orders_non_admin
  ),
  sums AS (
    SELECT
      count(*)::bigint AS c_orders,
      coalesce(sum(total), 0)::numeric(14,2) AS c_revenue
    FROM scoped_orders
  ),
  cust_count AS (
    SELECT
      CASE
        WHEN (SELECT is_admin FROM viewer_flags)
          THEN (SELECT count(*)::bigint FROM public.shopify_customers)
        ELSE (SELECT count(*)::bigint FROM scoped_customers)
      END AS c_customers
  )
  SELECT
    s.c_orders AS orders_count,
    c.c_customers AS customers_count,
    s.c_revenue AS revenue,
    CASE
      WHEN s.c_orders > 0 THEN round((s.c_revenue / s.c_orders)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_value
  FROM sums s
  CROSS JOIN cust_count c;
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
  scoped_customers AS (
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
    UNION
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.salesperson_customer_assignments a
    INNER JOIN scope_users su ON su.user_id = a.salesperson_user_id
    INNER JOIN public.shopify_customers c ON c.id = a.customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
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
