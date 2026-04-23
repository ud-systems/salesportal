-- Make supervisor manager scorecards period-aware and manager-only.
CREATE OR REPLACE FUNCTION public.get_supervisor_manager_scope_scorecards(
  _supervisor_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  viewer_user_id UUID,
  viewer_role public.app_role,
  team_member_count BIGINT,
  team_customers_count BIGINT,
  team_orders_count BIGINT,
  team_revenue NUMERIC(14,2),
  manager_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH manager_scope AS (
    SELECT DISTINCT
      e.member_user_id AS manager_user_id
    FROM public.sales_hierarchy_edges e
    INNER JOIN public.user_roles ur
      ON ur.user_id = e.member_user_id
     AND ur.role = 'manager'
    WHERE e.leader_user_id = _supervisor_user_id
      AND e.leader_role = 'supervisor'
  ),
  manager_rollup AS (
    SELECT
      ms.manager_user_id AS viewer_user_id,
      'manager'::public.app_role AS viewer_role,
      (
        SELECT count(*)::bigint
        FROM public.sales_hierarchy_edges me
        WHERE me.leader_user_id = ms.manager_user_id
          AND me.leader_role = 'manager'
      ) AS team_member_count,
      coalesce(m.customers_count, 0)::bigint AS team_customers_count,
      coalesce(m.orders_count, 0)::bigint AS team_orders_count,
      coalesce(m.revenue, 0)::numeric(14,2) AS team_revenue
    FROM manager_scope ms
    LEFT JOIN LATERAL public.get_scope_order_metrics(
      ms.manager_user_id,
      _from_iso,
      _to_iso
    ) m ON true
  )
  SELECT
    mr.viewer_user_id,
    mr.viewer_role,
    mr.team_member_count,
    mr.team_customers_count,
    mr.team_orders_count,
    mr.team_revenue,
    COALESCE(NULLIF(max(sp.salesperson_name), ''), 'Manager') AS manager_name
  FROM manager_rollup mr
  LEFT JOIN public.user_roles sp
    ON sp.user_id = mr.viewer_user_id
   AND sp.role = 'salesperson'
  WHERE
    public.has_role(auth.uid(), 'admin')
    OR (
      auth.uid() = _supervisor_user_id
      AND public.has_role(auth.uid(), 'supervisor')
    )
  GROUP BY
    mr.viewer_user_id,
    mr.viewer_role,
    mr.team_member_count,
    mr.team_customers_count,
    mr.team_orders_count,
    mr.team_revenue
  ORDER BY mr.team_revenue DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_supervisor_manager_scope_scorecards(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
