-- Ensure manager-team order scope works even when caller passes manager IDs.
-- Expands requested manager IDs to their member salespeople server-side.

CREATE OR REPLACE FUNCTION public.get_scoped_order_ids_for_salespeople(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  order_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested_ids AS (
    SELECT DISTINCT unnest(
      CASE
        WHEN _salesperson_user_ids IS NULL OR cardinality(_salesperson_user_ids) = 0
          THEN ARRAY[]::uuid[]
        ELSE _salesperson_user_ids
      END
    ) AS user_id
  ),
  expanded_requested_ids AS (
    -- Keep explicitly requested IDs.
    SELECT user_id
    FROM requested_ids
    UNION
    -- If a requested ID is a manager, include its direct salespeople.
    SELECT DISTINCT e.member_user_id AS user_id
    FROM public.sales_hierarchy_edges e
    INNER JOIN requested_ids r ON r.user_id = e.leader_user_id
    WHERE e.leader_role = 'manager'
  ),
  scoped_customers AS (
    SELECT customer_id
    FROM public.get_scoped_customer_ids_for_salespeople(
      _viewer_user_id,
      CASE
        WHEN EXISTS (SELECT 1 FROM expanded_requested_ids)
          THEN (SELECT array_agg(DISTINCT user_id) FROM expanded_requested_ids)
        ELSE NULL
      END
    )
  ),
  customer_keys AS (
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.shopify_customers c
    INNER JOIN scoped_customers sc ON sc.customer_id = c.id
  ),
  scoped_orders AS (
    SELECT DISTINCT o.id AS order_id
    FROM public.shopify_orders o
    INNER JOIN customer_keys ck
      ON o.customer_id = ck.customer_id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND ck.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = ck.shopify_customer_id
      )
  )
  SELECT order_id FROM scoped_orders;
$$;
