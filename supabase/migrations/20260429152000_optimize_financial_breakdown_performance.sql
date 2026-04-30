-- Performance optimization pass for transparent financial breakdowns.
-- Goal: reduce dashboard latency without changing business logic.

-- 1) Indexes for order filtering and scoped joins
CREATE INDEX IF NOT EXISTS idx_shopify_orders_created_at_non_test
  ON public.shopify_orders (shopify_created_at)
  WHERE coalesce(test_order, false) = false;

CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer_created_non_test
  ON public.shopify_orders (customer_id, shopify_created_at)
  WHERE coalesce(test_order, false) = false;

CREATE INDEX IF NOT EXISTS idx_shopify_orders_shopify_customer_created_non_test
  ON public.shopify_orders (shopify_customer_id, shopify_created_at)
  WHERE customer_id IS NULL
    AND shopify_customer_id IS NOT NULL
    AND coalesce(test_order, false) = false;

CREATE INDEX IF NOT EXISTS idx_shopify_orders_status_created_non_test
  ON public.shopify_orders (financial_status, shopify_created_at)
  WHERE coalesce(test_order, false) = false;

-- 2) Expression indexes for ownership-name fallback matching
CREATE INDEX IF NOT EXISTS idx_shopify_customers_sp_assigned_norm
  ON public.shopify_customers ((lower(trim(coalesce(sp_assigned, '')))));

CREATE INDEX IF NOT EXISTS idx_shopify_customers_referred_by_norm
  ON public.shopify_customers ((lower(trim(coalesce(referred_by, '')))));

-- 3) Rework canonical breakdown RPC to avoid OR-heavy join plans
CREATE OR REPLACE FUNCTION public.get_scope_financial_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  customers_count BIGINT,
  orders_total_count BIGINT,
  orders_paid_count BIGINT,
  orders_pending_count BIGINT,
  orders_refunded_count BIGINT,
  gross_revenue NUMERIC(14,2),
  refunded_amount NUMERIC(14,2),
  net_revenue NUMERIC(14,2),
  avg_order_gross NUMERIC(14,2),
  avg_order_net NUMERIC(14,2)
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
    -- Admin path: all customers
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin

    UNION

    -- Non-admin path: assignment and name fallback
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
  filtered_scoped_customers AS (
    SELECT sc.customer_id
    FROM scoped_customers sc
    INNER JOIN public.shopify_customers c ON c.id = sc.customer_id
    WHERE (_from_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) <= _to_iso)
  ),
  admin_orders AS (
    SELECT
      o.id,
      coalesce(o.total, 0)::numeric AS total,
      public.normalize_financial_status(o.financial_status) AS status_norm
    FROM public.shopify_orders o
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_orders_direct AS (
    SELECT DISTINCT
      o.id,
      coalesce(o.total, 0)::numeric AS total,
      public.normalize_financial_status(o.financial_status) AS status_norm
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_orders_fallback AS (
    SELECT DISTINCT
      o.id,
      coalesce(o.total, 0)::numeric AS total,
      public.normalize_financial_status(o.financial_status) AS status_norm
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
  scoped_orders AS (
    SELECT DISTINCT id, total, status_norm FROM admin_orders
    UNION
    SELECT DISTINCT id, total, status_norm FROM scoped_orders_direct
    UNION
    SELECT DISTINCT id, total, status_norm FROM scoped_orders_fallback
  ),
  sums AS (
    SELECT
      count(*)::bigint AS c_orders_total,
      count(*) FILTER (WHERE status_norm IN ('paid', 'partially_paid'))::bigint AS c_orders_paid,
      count(*) FILTER (WHERE status_norm IN ('pending', 'authorized'))::bigint AS c_orders_pending,
      count(*) FILTER (WHERE status_norm IN ('refunded', 'partially_refunded', 'voided'))::bigint AS c_orders_refunded,
      coalesce(sum(total), 0)::numeric(14,2) AS c_gross_revenue,
      coalesce(sum(CASE WHEN status_norm IN ('refunded', 'partially_refunded', 'voided') THEN total ELSE 0 END), 0)::numeric(14,2) AS c_refunded_amount
    FROM scoped_orders
  )
  SELECT
    (SELECT count(*)::bigint FROM filtered_scoped_customers) AS customers_count,
    s.c_orders_total AS orders_total_count,
    s.c_orders_paid AS orders_paid_count,
    s.c_orders_pending AS orders_pending_count,
    s.c_orders_refunded AS orders_refunded_count,
    s.c_gross_revenue AS gross_revenue,
    s.c_refunded_amount AS refunded_amount,
    (s.c_gross_revenue - s.c_refunded_amount)::numeric(14,2) AS net_revenue,
    CASE
      WHEN s.c_orders_total > 0 THEN round((s.c_gross_revenue / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_gross,
    CASE
      WHEN s.c_orders_total > 0 THEN round(((s.c_gross_revenue - s.c_refunded_amount) / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net
  FROM sums s;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_financial_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
