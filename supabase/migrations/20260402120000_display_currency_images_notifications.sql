-- Product image URL from Shopify (featured image)
ALTER TABLE public.shopify_products
  ADD COLUMN IF NOT EXISTS featured_image_url TEXT;

-- Default store display currency (overridable in Settings)
INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('shop_display_currency', 'GBP', now())
ON CONFLICT (key) DO NOTHING;

-- Salespeople need to read display currency for formatting (admins already have full SELECT)
DROP POLICY IF EXISTS "Authenticated can read shop display currency" ON public.app_settings;
CREATE POLICY "Authenticated can read shop display currency"
  ON public.app_settings FOR SELECT
  TO authenticated
  USING (key = 'shop_display_currency');

-- In-app notifications (inserts from Edge Functions service role; users read/update own rows)
CREATE TABLE IF NOT EXISTS public.user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  entity_type TEXT,
  entity_id TEXT,
  payload JSONB,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_notifications_type_entity_unique UNIQUE (user_id, type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_unread
  ON public.user_notifications(user_id, created_at DESC)
  WHERE read_at IS NULL;

ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own notifications"
  ON public.user_notifications FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users update own notifications"
  ON public.user_notifications FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Note: INSERT only via service role (bypasses RLS) from shopify-webhook
