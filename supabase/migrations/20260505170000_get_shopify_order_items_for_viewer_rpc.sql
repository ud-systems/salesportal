-- Fetch line items for a single order using the same visibility rule as shopify_orders
-- (can_view_shopify_order). SECURITY DEFINER reads order/items after authorization so
-- managers/supervisors are not blocked by nested RLS or policy drift vs scoped list RPCs.

CREATE OR REPLACE FUNCTION public.get_shopify_order_items_for_viewer(
  _viewer_user_id UUID,
  _order_id UUID
)
RETURNS SETOF public.shopify_order_items
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_customer_id UUID;
  v_shopify_customer_id TEXT;
BEGIN
  IF _viewer_user_id IS NULL OR _order_id IS NULL THEN
    RETURN;
  END IF;

  IF auth.uid() IS NULL OR (auth.uid() <> _viewer_user_id AND NOT public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  SELECT o.customer_id, o.shopify_customer_id
  INTO v_customer_id, v_shopify_customer_id
  FROM public.shopify_orders o
  WHERE o.id = _order_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT public.can_view_shopify_order(_viewer_user_id, v_customer_id, v_shopify_customer_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT oi.*
  FROM public.shopify_order_items oi
  WHERE oi.order_id = _order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_shopify_order_items_for_viewer(UUID, UUID) TO authenticated, service_role;
