-- Rework user scope performance view to avoid runtime 500s from nested view chains.
-- Computes salesperson performance directly from base tables.

CREATE OR REPLACE VIEW public.v_user_scope_performance AS
WITH scoped AS (
  SELECT
    u.user_id AS viewer_user_id,
    unnest(coalesce(public.get_user_scope_user_ids(u.user_id), ARRAY[u.user_id]::uuid[])) AS scoped_user_id
  FROM (
    SELECT DISTINCT ur.user_id
    FROM public.user_roles ur
    WHERE ur.user_id IS NOT NULL
  ) u
),
user_primary_role AS (
  SELECT DISTINCT ON (ur.user_id)
    ur.user_id,
    ur.role
  FROM public.user_roles ur
  WHERE ur.user_id IS NOT NULL
  ORDER BY
    ur.user_id,
    CASE ur.role
      WHEN 'admin' THEN 1
      WHEN 'supervisor' THEN 2
      WHEN 'manager' THEN 3
      WHEN 'salesperson' THEN 4
      ELSE 99
    END
),
salesperson_base AS (
  SELECT DISTINCT ur.user_id AS salesperson_user_id
  FROM public.user_roles ur
  WHERE ur.role = 'salesperson'
    AND ur.user_id IS NOT NULL
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
),
salesperson_performance AS (
  SELECT
    sb.salesperson_user_id,
    coalesce(cr.customers_count, 0)::bigint AS customers_count,
    coalesce(orw.orders_count, 0)::bigint AS orders_count,
    coalesce(orw.revenue, 0)::numeric(14,2) AS revenue
  FROM salesperson_base sb
  LEFT JOIN customer_rollup cr ON cr.salesperson_user_id = sb.salesperson_user_id
  LEFT JOIN order_rollup orw ON orw.salesperson_user_id = sb.salesperson_user_id
)
SELECT
  s.viewer_user_id,
  upr.role AS viewer_role,
  count(DISTINCT p.salesperson_user_id)::bigint AS team_member_count,
  coalesce(sum(p.customers_count), 0)::bigint AS team_customers_count,
  coalesce(sum(p.orders_count), 0)::bigint AS team_orders_count,
  coalesce(sum(p.revenue), 0)::numeric(14,2) AS team_revenue
FROM scoped s
LEFT JOIN user_primary_role upr ON upr.user_id = s.viewer_user_id
LEFT JOIN salesperson_performance p ON p.salesperson_user_id = s.scoped_user_id
GROUP BY s.viewer_user_id, upr.role;
