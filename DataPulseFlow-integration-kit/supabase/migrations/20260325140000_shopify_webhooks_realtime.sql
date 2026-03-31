-- Shopify webhooks: idempotency + processing audit log

CREATE TABLE IF NOT EXISTS public.shopify_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  shop_domain TEXT NOT NULL,
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'processing',
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_received_at
  ON public.shopify_webhook_events(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_topic
  ON public.shopify_webhook_events(topic);

ALTER TABLE public.shopify_webhook_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'shopify_webhook_events'
      AND policyname = 'Admins can view webhook events'
  ) THEN
    CREATE POLICY "Admins can view webhook events"
      ON public.shopify_webhook_events
      FOR SELECT
      TO authenticated
      USING (public.has_role(auth.uid(), 'admin'));
  END IF;
END $$;
