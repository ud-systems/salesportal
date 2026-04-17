-- Centralize salesperson->order scope resolution in DB.
-- Supports both direct customer_id links and shopify_customer_id fallback links.

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
  WITH scoped_customers AS (
    SELECT customer_id
    FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids)
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

GRANT EXECUTE ON FUNCTION public.get_scoped_order_ids_for_salespeople(UUID, UUID[]) TO authenticated, service_role;
