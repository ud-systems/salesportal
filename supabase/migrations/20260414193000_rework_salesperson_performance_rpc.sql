-- Rework RPC to avoid view-chain runtime failures.
-- Computes salesperson performance directly from assignments/customers/orders.

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
  WITH salesperson_base AS (
    SELECT
      ur.user_id AS salesperson_user_id,
      COALESCE(NULLIF(max(ur.salesperson_name), ''), 'Salesperson') AS salesperson_name
    FROM public.user_roles ur
    WHERE ur.role = 'salesperson'
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
  ),
  customer_rollup AS (
    SELECT
      a.salesperson_user_id,
      count(DISTINCT a.customer_id)::bigint AS customers_count
    FROM public.salesperson_customer_assignments a
    GROUP BY a.salesperson_user_id
  ),
  order_rollup AS (
    SELECT
      a.salesperson_user_id,
      count(DISTINCT o.id)::bigint AS orders_count,
      coalesce(sum(coalesce(o.total, 0)), 0)::numeric(14,2) AS revenue
    FROM public.salesperson_customer_assignments a
    LEFT JOIN public.shopify_customers c ON c.id = a.customer_id
    LEFT JOIN public.shopify_orders o
      ON o.customer_id = a.customer_id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND c.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = c.shopify_customer_id
      )
    GROUP BY a.salesperson_user_id
  )
  SELECT
    v.salesperson_user_id,
    v.salesperson_name,
    COALESCE(cr.customers_count, 0) AS customers_count,
    COALESCE(orw.orders_count, 0) AS orders_count,
    COALESCE(orw.revenue, 0)::numeric(14,2) AS revenue
  FROM visibility_scope v
  LEFT JOIN customer_rollup cr ON cr.salesperson_user_id = v.salesperson_user_id
  LEFT JOIN order_rollup orw ON orw.salesperson_user_id = v.salesperson_user_id
  ORDER BY COALESCE(orw.revenue, 0) DESC, v.salesperson_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_salesperson_performance_rows(UUID, TEXT) TO authenticated, service_role;
