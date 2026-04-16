-- Fix runtime 500s on get_salesperson_performance_rows RPC
-- by removing enum-typed RPC arg fragility and hardening null handling.

DROP FUNCTION IF EXISTS public.get_salesperson_performance_rows(UUID, public.app_role);

CREATE OR REPLACE FUNCTION public.get_salesperson_performance_rows(
  _leader_user_id UUID DEFAULT NULL,
  _leader_role TEXT DEFAULT NULL
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
        AND COALESCE(_leader_role, '') IN ('manager', 'supervisor')
        AND (
          (_leader_role = 'manager' AND public.has_role(auth.uid(), 'manager'))
          OR (_leader_role = 'supervisor' AND public.has_role(auth.uid(), 'supervisor'))
        )
        AND p.salesperson_user_id IN (
          SELECT e.member_user_id
          FROM public.sales_hierarchy_edges e
          WHERE e.leader_user_id = _leader_user_id
            AND e.leader_role::text = _leader_role
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

GRANT EXECUTE ON FUNCTION public.get_salesperson_performance_rows(UUID, TEXT) TO authenticated, service_role;
