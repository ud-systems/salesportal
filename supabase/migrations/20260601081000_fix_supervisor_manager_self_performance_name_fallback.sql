-- Fix manager-self row: include name-based customer ownership fallback (sp_assigned/referred_by).

CREATE OR REPLACE FUNCTION public.get_supervisor_manager_self_performance_row(
  _supervisor_user_id UUID,
  _manager_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  manager_user_id UUID,
  manager_name TEXT,
  customers_count BIGINT,
  orders_count BIGINT,
  revenue NUMERIC(14,2)
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
  allowed_manager AS (
    SELECT _manager_user_id AS manager_user_id
    FROM authz a
    WHERE a.is_admin
       OR (
         a.is_self_supervisor
         AND EXISTS (
           SELECT 1
           FROM public.sales_hierarchy_edges e
           WHERE e.leader_user_id = _supervisor_user_id
             AND e.leader_role = 'supervisor'
             AND e.member_user_id = _manager_user_id
         )
       )
  ),
  manager_name AS (
    SELECT
      am.manager_user_id,
      coalesce(
        nullif(
          btrim((
            SELECT max(ur.salesperson_name)
            FROM public.user_roles ur
            WHERE ur.user_id = am.manager_user_id
              AND ur.salesperson_name IS NOT NULL
              AND btrim(ur.salesperson_name) <> ''
          )),
          ''
        ),
        nullif(btrim(coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', '')), ''),
        split_part(coalesce(au.email, ''), '@', 1),
        am.manager_user_id::text
      )::text AS manager_name
    FROM allowed_manager am
    LEFT JOIN auth.users au ON au.id = am.manager_user_id
  ),
  manager_scope_names AS (
    SELECT DISTINCT lower(trim(ur.salesperson_name)) AS salesperson_name_norm
    FROM allowed_manager am
    INNER JOIN public.user_roles ur
      ON ur.user_id = am.manager_user_id
    WHERE ur.salesperson_name IS NOT NULL
      AND btrim(ur.salesperson_name) <> ''
  ),
  manager_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
    FROM allowed_manager am
    INNER JOIN public.salesperson_customer_assignments a
      ON a.salesperson_user_id = am.manager_user_id
    INNER JOIN public.shopify_customers c
      ON c.id = a.customer_id
    WHERE (_from_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) <= _to_iso)
    UNION
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    WHERE (_from_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) <= _to_iso)
      AND EXISTS (
        SELECT 1
        FROM manager_scope_names msn
        WHERE msn.salesperson_name_norm = lower(trim(coalesce(c.sp_assigned, '')))
           OR msn.salesperson_name_norm = lower(trim(coalesce(c.referred_by, '')))
      )
  ),
  manager_orders AS (
    SELECT DISTINCT
      o.id AS order_id,
      CASE
        WHEN public.normalize_financial_status(o.financial_status) = 'voided' THEN 0::numeric
        ELSE coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric
      END AS order_amount
    FROM public.shopify_orders o
    INNER JOIN manager_customers mc
      ON o.customer_id = mc.customer_id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND mc.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = mc.shopify_customer_id
      )
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  )
  SELECT
    mn.manager_user_id,
    mn.manager_name,
    coalesce((SELECT count(*)::bigint FROM manager_customers), 0) AS customers_count,
    coalesce((SELECT count(*)::bigint FROM manager_orders), 0) AS orders_count,
    coalesce((SELECT sum(mo.order_amount) FROM manager_orders mo), 0)::numeric(14,2) AS revenue
  FROM manager_name mn;
$$;

GRANT EXECUTE ON FUNCTION public.get_supervisor_manager_self_performance_row(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ)
TO authenticated, service_role;
