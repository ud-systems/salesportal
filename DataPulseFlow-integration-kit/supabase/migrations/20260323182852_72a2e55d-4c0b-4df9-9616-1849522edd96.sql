-- Drop overly permissive policies and restrict writes to service_role only
DROP POLICY "Service can manage sync_logs" ON public.sync_logs;
DROP POLICY "Service can manage customers" ON public.shopify_customers;
DROP POLICY "Service can manage orders" ON public.shopify_orders;
DROP POLICY "Service can manage order items" ON public.shopify_order_items;
DROP POLICY "Service can manage products" ON public.shopify_products;
DROP POLICY "Service can manage variants" ON public.shopify_variants;

-- Service role bypasses RLS automatically, so no explicit policies needed for writes.
-- The edge function uses service role key which bypasses RLS.
-- No additional policies needed.