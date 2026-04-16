-- Runtime fixes for hierarchy dashboards and role transitions

DROP POLICY IF EXISTS "Leaders can view own hierarchy edges" ON public.sales_hierarchy_edges;
CREATE POLICY "Leaders can view own hierarchy edges"
  ON public.sales_hierarchy_edges
  FOR SELECT
  TO authenticated
  USING (
    leader_user_id = auth.uid()
    AND (
      (leader_role = 'manager' AND public.has_role(auth.uid(), 'manager'))
      OR (leader_role = 'supervisor' AND public.has_role(auth.uid(), 'supervisor'))
      OR public.has_role(auth.uid(), 'admin')
    )
  );

DROP POLICY IF EXISTS "Members can view own hierarchy edges" ON public.sales_hierarchy_edges;
CREATE POLICY "Members can view own hierarchy edges"
  ON public.sales_hierarchy_edges
  FOR SELECT
  TO authenticated
  USING (member_user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.get_salesperson_performance_rows(
  _leader_user_id UUID DEFAULT NULL,
  _leader_role public.app_role DEFAULT NULL
)
RETURNS TABLE (
  salesperson_user_id UUID,
  salesperson_name TEXT,
  customers_count BIGINT,
  orders_count BIGINT,
  revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH allowed_rows AS (
    SELECT p.*
    FROM public.v_salesperson_performance p
    WHERE
      public.has_role(auth.uid(), 'admin')
      OR (
        _leader_user_id IS NOT NULL
        AND auth.uid() = _leader_user_id
        AND _leader_role IN ('manager', 'supervisor')
        AND (
          (_leader_role = 'manager' AND public.has_role(auth.uid(), 'manager'))
          OR (_leader_role = 'supervisor' AND public.has_role(auth.uid(), 'supervisor'))
        )
        AND p.salesperson_user_id IN (
          SELECT e.member_user_id
          FROM public.sales_hierarchy_edges e
          WHERE e.leader_user_id = _leader_user_id
            AND e.leader_role = _leader_role
        )
      )
      OR (
        public.has_role(auth.uid(), 'salesperson')
        AND p.salesperson_user_id = auth.uid()
      )
  )
  SELECT
    salesperson_user_id,
    salesperson_name,
    customers_count,
    orders_count,
    revenue
  FROM allowed_rows
  ORDER BY revenue DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_salesperson_performance_rows(UUID, public.app_role) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_supervisor_manager_scope_scorecards(
  _supervisor_user_id UUID
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
  SELECT
    scope.viewer_user_id,
    scope.viewer_role,
    scope.team_member_count,
    scope.team_customers_count,
    scope.team_orders_count,
    scope.team_revenue,
    COALESCE(sp.salesperson_name, 'Manager') AS manager_name
  FROM public.v_user_scope_performance scope
  LEFT JOIN public.user_roles sp
    ON sp.user_id = scope.viewer_user_id
   AND sp.role = 'salesperson'
  WHERE
    (
      public.has_role(auth.uid(), 'admin')
      OR (
        auth.uid() = _supervisor_user_id
        AND public.has_role(auth.uid(), 'supervisor')
      )
    )
    AND scope.viewer_user_id IN (
      SELECT e.member_user_id
      FROM public.sales_hierarchy_edges e
      WHERE e.leader_user_id = _supervisor_user_id
        AND e.leader_role = 'supervisor'
    )
  ORDER BY scope.team_revenue DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_supervisor_manager_scope_scorecards(UUID) TO authenticated, service_role;
