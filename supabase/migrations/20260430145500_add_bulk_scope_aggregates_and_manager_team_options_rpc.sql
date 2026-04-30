-- Push common frontend aggregation to DB RPCs for faster scoped dashboards.

CREATE OR REPLACE FUNCTION public.get_scope_order_metrics_for_viewers(
  _viewer_user_ids UUID[],
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
  WITH input_viewers AS (
    SELECT DISTINCT unnest(coalesce(_viewer_user_ids, ARRAY[]::uuid[])) AS viewer_user_id
  ),
  scoped AS (
    SELECT
      coalesce(sum(m.orders_count), 0)::bigint AS orders_count,
      coalesce(sum(m.customers_count), 0)::bigint AS customers_count,
      coalesce(sum(m.revenue), 0)::numeric(14,2) AS revenue
    FROM input_viewers iv
    LEFT JOIN LATERAL public.get_scope_order_metrics(
      iv.viewer_user_id,
      _from_iso,
      _to_iso
    ) m ON true
  )
  SELECT
    s.orders_count,
    s.customers_count,
    s.revenue,
    CASE
      WHEN s.orders_count > 0 THEN round((s.revenue / s.orders_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_value
  FROM scoped s;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_order_metrics_for_viewers(UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
TO authenticated, service_role;

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
  avg_order_net NUMERIC(14,2)
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
      coalesce(sum(m.net_revenue), 0)::numeric(14,2) AS net_revenue
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
    END AS avg_order_net
  FROM scoped s;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_financial_breakdown_for_viewers(UUID[], TIMESTAMPTZ, TIMESTAMPTZ)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_manager_team_member_options(
  _manager_user_id UUID
)
RETURNS TABLE (
  user_id UUID,
  display_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH allowed AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (auth.uid() = _manager_user_id AND public.has_role(auth.uid(), 'manager')) AS is_self_manager
  ),
  members AS (
    SELECT DISTINCT e.member_user_id AS user_id
    FROM public.sales_hierarchy_edges e
    CROSS JOIN allowed a
    WHERE e.leader_user_id = _manager_user_id
      AND e.leader_role = 'manager'
      AND (a.is_admin OR a.is_self_manager)
  ),
  role_names AS (
    SELECT
      ur.user_id,
      max(NULLIF(btrim(ur.salesperson_name), '')) AS role_display_name
    FROM public.user_roles ur
    INNER JOIN members m ON m.user_id = ur.user_id
    GROUP BY ur.user_id
  )
  SELECT
    m.user_id,
    coalesce(
      rn.role_display_name,
      nullif(btrim(coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', '')), ''),
      split_part(coalesce(au.email, ''), '@', 1),
      m.user_id::text
    )::text AS display_name
  FROM members m
  LEFT JOIN role_names rn ON rn.user_id = m.user_id
  LEFT JOIN auth.users au ON au.id = m.user_id
  ORDER BY display_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_manager_team_member_options(UUID)
TO authenticated, service_role;
