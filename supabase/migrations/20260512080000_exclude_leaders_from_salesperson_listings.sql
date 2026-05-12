-- Exclude users who also hold a manager or supervisor role from being treated as
-- "pure salespeople" when listing team members under a manager.
--
-- Context: admin-users edge function (buildRoleRows) intentionally writes BOTH a
-- 'salesperson' row AND a 'manager'/'supervisor' row in public.user_roles whenever
-- a leader role is assigned. That lets leaders own customer assignments, but it
-- also caused leaders to leak into manager team rows whenever they were attached
-- to a manager's hierarchy edges (e.g. a supervisor accidentally showing up under
-- their own direct report manager).
--
-- This migration:
--   1) Filters salesperson_base in get_salesperson_performance_rows so it only
--      returns users whose roles do NOT include 'manager' or 'supervisor'.
--   2) Adds a new RPC get_pure_salespeople_under_managers used by the React
--      dropdown so leaders are excluded everywhere we surface "salespeople under
--      manager X".

CREATE OR REPLACE FUNCTION public.get_salesperson_performance_rows(
  _leader_user_id UUID DEFAULT NULL,
  _leader_role TEXT DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
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
  WITH salesperson_base AS (
    SELECT
      ur.user_id AS salesperson_user_id,
      COALESCE(NULLIF(max(ur.salesperson_name), ''), 'Salesperson') AS salesperson_name
    FROM public.user_roles ur
    WHERE ur.role = 'salesperson'
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur_leader
        WHERE ur_leader.user_id = ur.user_id
          AND ur_leader.role IN ('manager', 'supervisor', 'admin', 'owner')
      )
    GROUP BY ur.user_id
  ),
  visibility_scope AS (
    SELECT sb.salesperson_user_id, sb.salesperson_name
    FROM salesperson_base sb
    WHERE
      public.has_role(auth.uid(), 'admin')
      OR (
        public.has_role(auth.uid(), 'salesperson')
        AND sb.salesperson_user_id = auth.uid()
      )
      OR (
        _leader_user_id IS NOT NULL
        AND auth.uid() = _leader_user_id
        AND COALESCE(_leader_role, '') IN ('manager', 'supervisor')
        AND (
          (_leader_role = 'manager' AND public.has_role(auth.uid(), 'manager'))
          OR (_leader_role = 'supervisor' AND public.has_role(auth.uid(), 'supervisor'))
        )
        AND sb.salesperson_user_id IN (
          SELECT e.member_user_id
          FROM public.sales_hierarchy_edges e
          WHERE e.leader_user_id = _leader_user_id
            AND e.leader_role::text = _leader_role
        )
      )
      OR (
        public.has_role(auth.uid(), 'supervisor')
        AND COALESCE(_leader_role, '') = 'manager'
        AND _leader_user_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.sales_hierarchy_edges e_sup
          WHERE e_sup.leader_user_id = auth.uid()
            AND e_sup.leader_role::text = 'supervisor'
            AND e_sup.member_user_id = _leader_user_id
        )
        AND sb.salesperson_user_id IN (
          SELECT e_m.member_user_id
          FROM public.sales_hierarchy_edges e_m
          WHERE e_m.leader_user_id = _leader_user_id
            AND e_m.leader_role::text = 'manager'
        )
      )
  ),
  assignment_customers AS (
    SELECT DISTINCT
      a.salesperson_user_id,
      a.customer_id,
      c.shopify_customer_id,
      c.shopify_created_at,
      c.created_at
    FROM public.salesperson_customer_assignments a
    LEFT JOIN public.shopify_customers c ON c.id = a.customer_id
  ),
  customer_rollup AS (
    SELECT
      ac.salesperson_user_id,
      count(DISTINCT ac.customer_id)::bigint AS customers_count
    FROM assignment_customers ac
    WHERE (_from_iso IS NULL OR coalesce(ac.shopify_created_at, ac.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(ac.shopify_created_at, ac.created_at) <= _to_iso)
    GROUP BY ac.salesperson_user_id
  ),
  order_matches AS (
    SELECT
      ac.salesperson_user_id,
      o.id AS order_id,
      coalesce(o.current_total, o.total, 0)::numeric AS total
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o ON o.customer_id = ac.customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
    UNION
    SELECT
      ac.salesperson_user_id,
      o.id AS order_id,
      coalesce(o.current_total, o.total, 0)::numeric AS total
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND ac.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = ac.shopify_customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  order_rollup AS (
    SELECT
      om.salesperson_user_id,
      count(DISTINCT om.order_id)::bigint AS orders_count,
      coalesce(sum(om.total), 0)::numeric(14,2) AS revenue
    FROM order_matches om
    GROUP BY om.salesperson_user_id
  )
  SELECT
    v.salesperson_user_id,
    v.salesperson_name,
    coalesce(cr.customers_count, 0) AS customers_count,
    coalesce(orw.orders_count, 0) AS orders_count,
    coalesce(orw.revenue, 0)::numeric(14,2) AS revenue
  FROM visibility_scope v
  LEFT JOIN customer_rollup cr ON cr.salesperson_user_id = v.salesperson_user_id
  LEFT JOIN order_rollup orw ON orw.salesperson_user_id = v.salesperson_user_id
  ORDER BY coalesce(orw.revenue, 0) DESC, v.salesperson_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_salesperson_performance_rows(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

-- New helper RPC: returns the set of pure-salesperson user ids that report into the
-- supplied managers via sales_hierarchy_edges. "Pure salesperson" = user_roles row
-- with role='salesperson' AND no manager/supervisor/admin/owner row for the same user.
-- Used by the Supervisor and Manager dashboards to populate the Salesperson filter
-- dropdown so that leaders (e.g. a supervisor user) never leak into a manager's
-- salesperson list, even when accidentally present in sales_hierarchy_edges.
CREATE OR REPLACE FUNCTION public.get_pure_salespeople_under_managers(
  _manager_user_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  user_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH input_managers AS (
    SELECT DISTINCT unnest(coalesce(_manager_user_ids, ARRAY[]::uuid[])) AS manager_user_id
  ),
  authorized_managers AS (
    SELECT im.manager_user_id
    FROM input_managers im
    WHERE
      public.has_role(auth.uid(), 'admin')
      OR (
        public.has_role(auth.uid(), 'manager')
        AND im.manager_user_id = auth.uid()
      )
      OR (
        public.has_role(auth.uid(), 'supervisor')
        AND EXISTS (
          SELECT 1
          FROM public.sales_hierarchy_edges e_sup
          WHERE e_sup.leader_user_id = auth.uid()
            AND e_sup.leader_role::text = 'supervisor'
            AND e_sup.member_user_id = im.manager_user_id
        )
      )
  ),
  member_ids AS (
    SELECT DISTINCT e.member_user_id
    FROM public.sales_hierarchy_edges e
    INNER JOIN authorized_managers am ON am.manager_user_id = e.leader_user_id
    WHERE e.leader_role::text = 'manager'
  )
  SELECT m.member_user_id AS user_id
  FROM member_ids m
  WHERE EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = m.member_user_id
        AND ur.role = 'salesperson'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_roles ur_leader
      WHERE ur_leader.user_id = m.member_user_id
        AND ur_leader.role IN ('manager', 'supervisor', 'admin', 'owner')
    );
$$;

GRANT EXECUTE ON FUNCTION public.get_pure_salespeople_under_managers(UUID[]) TO authenticated, service_role;

-- Patch the supervisor salesperson option RPC to exclude any member that also
-- holds a leader role (manager/supervisor/admin/owner). Same root cause: the
-- admin-users edge function gives leaders an implicit 'salesperson' user_roles
-- row, so leaders that appear as members in sales_hierarchy_edges would leak
-- into the Salesperson dropdown of the Supervisor dashboard.
CREATE OR REPLACE FUNCTION public.get_supervisor_salesperson_options(
  _supervisor_user_id UUID
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
  WITH authz AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (auth.uid() = _supervisor_user_id AND public.has_role(auth.uid(), 'supervisor')) AS is_self_supervisor
  ),
  manager_scope AS (
    SELECT DISTINCT
      e.member_user_id AS manager_user_id
    FROM public.sales_hierarchy_edges e
    CROSS JOIN authz a
    WHERE e.leader_user_id = _supervisor_user_id
      AND e.leader_role = 'supervisor'
      AND (a.is_admin OR a.is_self_supervisor)
  ),
  salesperson_scope AS (
    SELECT DISTINCT
      e.member_user_id AS salesperson_user_id
    FROM public.sales_hierarchy_edges e
    INNER JOIN manager_scope ms ON ms.manager_user_id = e.leader_user_id
    WHERE e.leader_role = 'manager'
      AND EXISTS (
        SELECT 1
        FROM public.user_roles ur_sp
        WHERE ur_sp.user_id = e.member_user_id
          AND ur_sp.role = 'salesperson'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur_leader
        WHERE ur_leader.user_id = e.member_user_id
          AND ur_leader.role IN ('manager', 'supervisor', 'admin', 'owner')
      )
  ),
  role_names AS (
    SELECT
      ur.user_id,
      max(NULLIF(btrim(ur.salesperson_name), '')) AS role_display_name
    FROM public.user_roles ur
    INNER JOIN salesperson_scope ss ON ss.salesperson_user_id = ur.user_id
    GROUP BY ur.user_id
  )
  SELECT
    ss.salesperson_user_id AS user_id,
    coalesce(
      rn.role_display_name,
      nullif(btrim(coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', '')), ''),
      split_part(coalesce(au.email, ''), '@', 1),
      ss.salesperson_user_id::text
    )::text AS display_name
  FROM salesperson_scope ss
  LEFT JOIN role_names rn ON rn.user_id = ss.salesperson_user_id
  LEFT JOIN auth.users au ON au.id = ss.salesperson_user_id
  ORDER BY display_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_supervisor_salesperson_options(UUID)
TO authenticated, service_role;

-- Same exclusion for the Manager dashboard's "Team member" filter dropdown.
-- Without this, a supervisor (who also has an implicit salesperson user_roles
-- row) that appears as a member in the manager's sales_hierarchy_edges leaks
-- into the dropdown and team listings.
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
      (auth.uid() = _manager_user_id AND public.has_role(auth.uid(), 'manager')) AS is_self_manager,
      (
        public.has_role(auth.uid(), 'supervisor')
        AND EXISTS (
          SELECT 1
          FROM public.sales_hierarchy_edges e_sup
          WHERE e_sup.leader_user_id = auth.uid()
            AND e_sup.leader_role::text = 'supervisor'
            AND e_sup.member_user_id = _manager_user_id
        )
      ) AS is_overseeing_supervisor
  ),
  members AS (
    SELECT DISTINCT e.member_user_id AS user_id
    FROM public.sales_hierarchy_edges e
    CROSS JOIN allowed a
    WHERE e.leader_user_id = _manager_user_id
      AND e.leader_role = 'manager'
      AND (a.is_admin OR a.is_self_manager OR a.is_overseeing_supervisor)
      AND EXISTS (
        SELECT 1
        FROM public.user_roles ur_sp
        WHERE ur_sp.user_id = e.member_user_id
          AND ur_sp.role = 'salesperson'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur_leader
        WHERE ur_leader.user_id = e.member_user_id
          AND ur_leader.role IN ('manager', 'supervisor', 'admin', 'owner')
      )
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
