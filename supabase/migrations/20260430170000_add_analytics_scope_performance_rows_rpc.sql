-- Consolidate analytics team performance report rows into one RPC
-- to remove frontend N+1 metric fanout.

CREATE OR REPLACE FUNCTION public.get_analytics_scope_performance_rows(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _role_filter TEXT DEFAULT 'all'
)
RETURNS TABLE (
  viewer_user_id UUID,
  viewer_name TEXT,
  viewer_role public.app_role,
  team_member_count BIGINT,
  team_customers_count BIGINT,
  team_orders_count BIGINT,
  team_revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  WITH authz AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (auth.uid() = _viewer_user_id) AS is_self
  ),
  allowed_viewers AS (
    SELECT v.viewer_user_id
    FROM public.v_user_scope_performance v
    CROSS JOIN authz a
    WHERE a.is_admin
    UNION
    SELECT DISTINCT unnest(
      coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])
    ) AS viewer_user_id
    FROM authz a
    WHERE NOT a.is_admin AND a.is_self
    UNION
    SELECT _viewer_user_id
    FROM authz a
    WHERE NOT a.is_admin AND a.is_self
  ),
  role_names AS (
    SELECT
      ur.user_id,
      max(NULLIF(btrim(ur.salesperson_name), '')) AS role_display_name
    FROM public.user_roles ur
    GROUP BY ur.user_id
  ),
  base AS (
    SELECT
      v.viewer_user_id,
      v.viewer_role,
      v.team_member_count
    FROM public.v_user_scope_performance v
    INNER JOIN allowed_viewers av ON av.viewer_user_id = v.viewer_user_id
    WHERE (
      lower(coalesce(_role_filter, 'all')) = 'all'
      OR (lower(_role_filter) = 'manager' AND v.viewer_role = 'manager')
      OR (lower(_role_filter) = 'supervisor' AND v.viewer_role = 'supervisor')
    )
  )
  SELECT
    b.viewer_user_id,
    coalesce(
      rn.role_display_name,
      nullif(btrim(coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', '')), ''),
      split_part(coalesce(au.email, ''), '@', 1),
      b.viewer_user_id::text
    )::text AS viewer_name,
    b.viewer_role,
    b.team_member_count,
    coalesce(m.customers_count, 0)::bigint AS team_customers_count,
    coalesce(m.orders_count, 0)::bigint AS team_orders_count,
    coalesce(m.revenue, 0)::numeric(14,2) AS team_revenue
  FROM base b
  LEFT JOIN role_names rn ON rn.user_id = b.viewer_user_id
  LEFT JOIN auth.users au ON au.id = b.viewer_user_id
  LEFT JOIN LATERAL public.get_scope_order_metrics(
    b.viewer_user_id,
    _from_iso,
    _to_iso
  ) m ON true
  ORDER BY team_revenue DESC, viewer_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_analytics_scope_performance_rows(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT)
TO authenticated, service_role;
