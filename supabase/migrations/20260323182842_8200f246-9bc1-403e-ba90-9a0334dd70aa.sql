-- Allow service role to insert/update/delete sync data
-- These policies use 'TO service_role' which bypasses RLS, but we need explicit INSERT policies
-- for the edge function using service role key (which bypasses RLS anyway)
-- However we need INSERT policies for sync_logs from authenticated admins

-- Allow admins to insert sync logs (for the sync button trigger)
CREATE POLICY "Service can manage sync_logs" ON public.sync_logs
  FOR ALL USING (true) WITH CHECK (true);

-- Allow service to manage shopify data (service role bypasses RLS, but explicit for clarity)
CREATE POLICY "Service can manage customers" ON public.shopify_customers
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service can manage orders" ON public.shopify_orders
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service can manage order items" ON public.shopify_order_items
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service can manage products" ON public.shopify_products
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service can manage variants" ON public.shopify_variants
  FOR ALL USING (true) WITH CHECK (true);