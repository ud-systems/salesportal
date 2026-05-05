-- get_shopify_order_items_for_viewer previously authorized with can_view_shopify_order only.
-- That function checks salesperson_customer_assignments exclusively.
--
-- The Orders page list uses get_scoped_orders_page → scoped_customers built like
-- get_scoped_customer_ids_for_salespeople, which ALSO includes customers matched by
-- sp_assigned / referred_by against team members' user_roles.salesperson_name (fallback path).
-- Orders therefore appear for managers even when can_view_shopify_order is false.
-- Align line-item authorization with that same customer scope.

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
  v_allowed BOOLEAN;
BEGIN
  IF _viewer_user_id IS NULL OR _order_id IS NULL THEN
    RETURN;
  END IF;

  IF auth.uid() IS NULL OR (auth.uid() <> _viewer_user_id AND NOT public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  IF public.has_role(_viewer_user_id, 'admin') THEN
    RETURN QUERY
    SELECT oi.*
    FROM public.shopify_order_items oi
    WHERE oi.order_id = _order_id;
    RETURN;
  END IF;

  SELECT o.customer_id, o.shopify_customer_id
  INTO v_customer_id, v_shopify_customer_id
  FROM public.shopify_orders o
  WHERE o.id = _order_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Same customer universe as get_scoped_customer_ids_for_salespeople with no salesperson
  -- subset: viewer_scope team + assignment rows + name fallback (see 20260417170000).
  v_allowed := (
    v_customer_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, NULL) sc
      WHERE sc.customer_id = v_customer_id
    )
  ) OR (
    v_customer_id IS NULL
    AND v_shopify_customer_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.shopify_customers c
      WHERE c.shopify_customer_id = v_shopify_customer_id
        AND EXISTS (
          SELECT 1
          FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, NULL) sc
          WHERE sc.customer_id = c.id
        )
    )
  );

  IF NOT coalesce(v_allowed, false) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT oi.*
  FROM public.shopify_order_items oi
  WHERE oi.order_id = _order_id;
END;
$$;
