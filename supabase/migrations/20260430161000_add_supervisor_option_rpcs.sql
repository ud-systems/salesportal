-- Lightweight option RPCs for supervisor selectors across pages.
-- Avoids heavy scorecard/performance RPCs when only dropdown options are needed.

CREATE OR REPLACE FUNCTION public.get_supervisor_manager_options(
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
      AND (
        EXISTS (
          SELECT 1
          FROM public.user_roles ur
          WHERE ur.user_id = e.member_user_id
            AND ur.role = 'manager'
        )
        OR EXISTS (
          SELECT 1
          FROM public.sales_hierarchy_edges me
          WHERE me.leader_user_id = e.member_user_id
            AND me.leader_role = 'manager'
        )
      )
  ),
  role_names AS (
    SELECT
      ur.user_id,
      max(NULLIF(btrim(ur.salesperson_name), '')) AS role_display_name
    FROM public.user_roles ur
    INNER JOIN manager_scope ms ON ms.manager_user_id = ur.user_id
    GROUP BY ur.user_id
  )
  SELECT
    ms.manager_user_id AS user_id,
    coalesce(
      rn.role_display_name,
      nullif(btrim(coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', '')), ''),
      split_part(coalesce(au.email, ''), '@', 1),
      ms.manager_user_id::text
    )::text AS display_name
  FROM manager_scope ms
  LEFT JOIN role_names rn ON rn.user_id = ms.manager_user_id
  LEFT JOIN auth.users au ON au.id = ms.manager_user_id
  ORDER BY display_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_supervisor_manager_options(UUID)
TO authenticated, service_role;

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
