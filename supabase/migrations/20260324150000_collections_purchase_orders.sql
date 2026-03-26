-- Collections + purchase orders support

CREATE TABLE IF NOT EXISTS public.shopify_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_collection_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  handle TEXT,
  collection_type TEXT DEFAULT 'custom',
  products_count INTEGER DEFAULT 0,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.shopify_collections ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'shopify_collections' AND policyname = 'Authenticated users can view collections'
  ) THEN
    CREATE POLICY "Authenticated users can view collections" ON public.shopify_collections
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number TEXT UNIQUE NOT NULL,
  supplier_name TEXT,
  status TEXT DEFAULT 'draft',
  total_amount NUMERIC(12,2) DEFAULT 0,
  currency_code TEXT DEFAULT 'USD',
  po_date TIMESTAMPTZ,
  expected_date TIMESTAMPTZ,
  notes TEXT,
  source TEXT DEFAULT 'shopify_tagged_order',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.purchase_orders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'purchase_orders' AND policyname = 'Authenticated users can view purchase orders'
  ) THEN
    CREATE POLICY "Authenticated users can view purchase orders" ON public.purchase_orders
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shopify_collections_updated_at ON public.shopify_collections(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_po_date ON public.purchase_orders(po_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON public.purchase_orders(status);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_shopify_collections_updated_at') THEN
    CREATE TRIGGER update_shopify_collections_updated_at
      BEFORE UPDATE ON public.shopify_collections
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_purchase_orders_updated_at') THEN
    CREATE TRIGGER update_purchase_orders_updated_at
      BEFORE UPDATE ON public.purchase_orders
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;
