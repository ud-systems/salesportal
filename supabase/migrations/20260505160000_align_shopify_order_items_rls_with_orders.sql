-- Line items SELECT must match shopify_orders visibility (can_view_shopify_order).
-- The prior policy required app_role 'salesperson', which blocked managers/supervisors
-- even though they could read scoped orders. Parent-order RLS is enforced via EXISTS.

DROP POLICY IF EXISTS "Salespersons see their order items" ON public.shopify_order_items;

CREATE POLICY "Scoped users see order items for visible orders"
  ON public.shopify_order_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.shopify_orders o
      WHERE o.id = shopify_order_items.order_id
    )
  );
