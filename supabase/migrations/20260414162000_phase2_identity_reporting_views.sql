-- Phase 2: identity-based attribution and performance views

CREATE OR REPLACE VIEW public.v_salesperson_customer_attribution AS
WITH salesperson_rows AS (
  SELECT
    ur.user_id AS salesperson_user_id,
    max(ur.salesperson_name) FILTER (WHERE ur.salesperson_name IS NOT NULL AND ur.salesperson_name <> '') AS salesperson_name
  FROM public.user_roles ur
  WHERE ur.role = 'salesperson'
  GROUP BY ur.user_id
)
SELECT
  a.salesperson_user_id,
  coalesce(sr.salesperson_name, 'Unknown') AS salesperson_name,
  a.customer_id
FROM public.salesperson_customer_assignments a
LEFT JOIN salesperson_rows sr ON sr.salesperson_user_id = a.salesperson_user_id;

CREATE OR REPLACE VIEW public.v_salesperson_performance AS
WITH order_rollup AS (
  SELECT
    a.salesperson_user_id,
    count(DISTINCT o.id) AS orders_count,
    coalesce(sum(coalesce(o.total, 0)), 0)::numeric(14,2) AS revenue
  FROM public.v_salesperson_customer_attribution a
  LEFT JOIN public.shopify_orders o
    ON o.customer_id = a.customer_id
    OR (
      o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = (
        SELECT c.shopify_customer_id FROM public.shopify_customers c WHERE c.id = a.customer_id
      )
    )
  GROUP BY a.salesperson_user_id
),
customer_rollup AS (
  SELECT
    a.salesperson_user_id,
    count(DISTINCT a.customer_id) AS customers_count
  FROM public.v_salesperson_customer_attribution a
  GROUP BY a.salesperson_user_id
)
SELECT
  a.salesperson_user_id,
  a.salesperson_name,
  coalesce(c.customers_count, 0) AS customers_count,
  coalesce(o.orders_count, 0) AS orders_count,
  coalesce(o.revenue, 0)::numeric(14,2) AS revenue
FROM (
  SELECT DISTINCT salesperson_user_id, salesperson_name
  FROM public.v_salesperson_customer_attribution
) a
LEFT JOIN customer_rollup c ON c.salesperson_user_id = a.salesperson_user_id
LEFT JOIN order_rollup o ON o.salesperson_user_id = a.salesperson_user_id;

CREATE OR REPLACE VIEW public.v_user_scope_performance AS
WITH scoped AS (
  SELECT
    u.user_id AS viewer_user_id,
    unnest(coalesce(public.get_user_scope_user_ids(u.user_id), ARRAY[u.user_id]::uuid[])) AS scoped_user_id
  FROM (SELECT DISTINCT user_id FROM public.user_roles) u
),
user_primary_role AS (
  SELECT DISTINCT ON (ur.user_id)
    ur.user_id,
    ur.role
  FROM public.user_roles ur
  ORDER BY
    ur.user_id,
    CASE ur.role
      WHEN 'admin' THEN 1
      WHEN 'supervisor' THEN 2
      WHEN 'manager' THEN 3
      WHEN 'salesperson' THEN 4
      ELSE 99
    END
)
SELECT
  s.viewer_user_id,
  upr.role AS viewer_role,
  count(DISTINCT p.salesperson_user_id) AS team_member_count,
  coalesce(sum(p.customers_count), 0)::bigint AS team_customers_count,
  coalesce(sum(p.orders_count), 0)::bigint AS team_orders_count,
  coalesce(sum(p.revenue), 0)::numeric(14,2) AS team_revenue
FROM scoped s
LEFT JOIN user_primary_role upr ON upr.user_id = s.viewer_user_id
LEFT JOIN public.v_salesperson_performance p ON p.salesperson_user_id = s.scoped_user_id
GROUP BY s.viewer_user_id, upr.role;
