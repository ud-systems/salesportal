-- Add multi-shipment tracking support and latest-tracking summary fields.

ALTER TABLE public.shopify_orders
  ADD COLUMN IF NOT EXISTS latest_tracking_number TEXT,
  ADD COLUMN IF NOT EXISTS latest_tracking_url TEXT,
  ADD COLUMN IF NOT EXISTS latest_tracking_company TEXT,
  ADD COLUMN IF NOT EXISTS latest_tracking_status TEXT,
  ADD COLUMN IF NOT EXISTS latest_fulfillment_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.shopify_order_fulfillments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.shopify_orders(id) ON DELETE CASCADE,
  shopify_fulfillment_id TEXT NOT NULL,
  shipment_status TEXT,
  tracking_company TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  fulfilled_at TIMESTAMPTZ,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, shopify_fulfillment_id)
);

ALTER TABLE public.shopify_order_fulfillments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view scoped order fulfillments" ON public.shopify_order_fulfillments;
CREATE POLICY "Authenticated users can view scoped order fulfillments"
  ON public.shopify_order_fulfillments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.shopify_orders o
      WHERE o.id = shopify_order_fulfillments.order_id
    )
  );

DROP POLICY IF EXISTS "Service can manage order fulfillments" ON public.shopify_order_fulfillments;
CREATE POLICY "Service can manage order fulfillments"
  ON public.shopify_order_fulfillments
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_shopify_order_fulfillments_order_id
  ON public.shopify_order_fulfillments(order_id);

CREATE INDEX IF NOT EXISTS idx_shopify_order_fulfillments_tracking_number
  ON public.shopify_order_fulfillments(tracking_number);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_latest_tracking_number
  ON public.shopify_orders(latest_tracking_number);

DROP TRIGGER IF EXISTS update_shopify_order_fulfillments_updated_at ON public.shopify_order_fulfillments;
CREATE TRIGGER update_shopify_order_fulfillments_updated_at
  BEFORE UPDATE ON public.shopify_order_fulfillments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
