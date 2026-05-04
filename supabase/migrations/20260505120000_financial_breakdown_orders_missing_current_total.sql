-- Count orders where current_total was never synced (NULL). In that case coalesce(current_total, total)
-- makes gross equal net; expose count so UI can warn users to run Shopify order sync.
-- Postgres cannot change RETURNS TABLE shape via CREATE OR REPLACE; drop first.

DROP FUNCTION IF EXISTS public.get_scope_financial_breakdown_for_viewers(uuid[], timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.get_scope_financial_breakdown(uuid, timestamptz, timestamptz);

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
  avg_order_net NUMERIC(14,2),
  orders_missing_current_total BIGINT
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
      coalesce(o.total, 0)::numeric AS total_orig,
      coalesce(o.current_total, o.total, 0)::numeric AS total_curr,
      public.normalize_financial_status(o.financial_status) AS status_norm,
      (o.current_total IS NULL) AS missing_curr
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
      coalesce(o.total, 0)::numeric AS total_orig,
      coalesce(o.current_total, o.total, 0)::numeric AS total_curr,
      public.normalize_financial_status(o.financial_status) AS status_norm,
      (o.current_total IS NULL) AS missing_curr
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
      coalesce(o.total, 0)::numeric AS total_orig,
      coalesce(o.current_total, o.total, 0)::numeric AS total_curr,
      public.normalize_financial_status(o.financial_status) AS status_norm,
      (o.current_total IS NULL) AS missing_curr
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
    SELECT DISTINCT ON (id)
      id,
      total_orig,
      total_curr,
      status_norm,
      missing_curr
    FROM (
      SELECT * FROM admin_orders
      UNION ALL
      SELECT * FROM scoped_orders_direct
      UNION ALL
      SELECT * FROM scoped_orders_fallback
    ) u
    ORDER BY id, missing_curr DESC
  ),
  sums AS (
    SELECT
      count(*)::bigint AS c_orders_total,
      count(*) FILTER (WHERE status_norm IN ('paid', 'partially_paid'))::bigint AS c_orders_paid,
      count(*) FILTER (WHERE status_norm IN ('pending', 'authorized'))::bigint AS c_orders_pending,
      count(*) FILTER (WHERE status_norm IN ('refunded', 'partially_refunded', 'voided'))::bigint AS c_orders_refunded,
      count(*) FILTER (WHERE missing_curr)::bigint AS c_orders_missing_current_total,
      coalesce(sum(total_orig), 0)::numeric(14,2) AS c_gross_revenue,
      coalesce(sum(greatest(total_orig - total_curr, 0::numeric)), 0)::numeric(14,2) AS c_refunded_amount,
      coalesce(sum(total_curr), 0)::numeric(14,2) AS c_net_revenue
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
    s.c_net_revenue AS net_revenue,
    CASE
      WHEN s.c_orders_total > 0 THEN round((s.c_gross_revenue / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_gross,
    CASE
      WHEN s.c_orders_total > 0 THEN round((s.c_net_revenue / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net,
    s.c_orders_missing_current_total AS orders_missing_current_total
  FROM sums s;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_financial_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_scope_financial_breakdown_for_viewers(
  _viewer_user_ids UUID[],
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
  avg_order_net NUMERIC(14,2),
  orders_missing_current_total BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH input_viewers AS (
    SELECT DISTINCT unnest(coalesce(_viewer_user_ids, ARRAY[]::uuid[])) AS viewer_user_id
  ),
  scoped AS (
    SELECT
      coalesce(sum(m.customers_count), 0)::bigint AS customers_count,
      coalesce(sum(m.orders_total_count), 0)::bigint AS orders_total_count,
      coalesce(sum(m.orders_paid_count), 0)::bigint AS orders_paid_count,
      coalesce(sum(m.orders_pending_count), 0)::bigint AS orders_pending_count,
      coalesce(sum(m.orders_refunded_count), 0)::bigint AS orders_refunded_count,
      coalesce(sum(m.gross_revenue), 0)::numeric(14,2) AS gross_revenue,
      coalesce(sum(m.refunded_amount), 0)::numeric(14,2) AS refunded_amount,
      coalesce(sum(m.net_revenue), 0)::numeric(14,2) AS net_revenue,
      coalesce(sum(m.orders_missing_current_total), 0)::bigint AS orders_missing_current_total
    FROM input_viewers iv
    LEFT JOIN LATERAL public.get_scope_financial_breakdown(
      iv.viewer_user_id,
      _from_iso,
      _to_iso
    ) m ON true
  )
  SELECT
    s.customers_count,
    s.orders_total_count,
    s.orders_paid_count,
    s.orders_pending_count,
    s.orders_refunded_count,
    s.gross_revenue,
    s.refunded_amount,
    s.net_revenue,
    CASE
      WHEN s.orders_total_count > 0 THEN round((s.gross_revenue / s.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_gross,
    CASE
      WHEN s.orders_total_count > 0 THEN round((s.net_revenue / s.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net,
    s.orders_missing_current_total
  FROM scoped s;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_financial_breakdown_for_viewers(UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
TO authenticated, service_role;
