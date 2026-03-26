-- Richer mapping from Shopify Admin API → local tables (see shopify-sync edge function)

ALTER TABLE public.shopify_customers
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS last_name text,
  ADD COLUMN IF NOT EXISTS address1 text,
  ADD COLUMN IF NOT EXISTS address2 text,
  ADD COLUMN IF NOT EXISTS province text,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS zip text,
  ADD COLUMN IF NOT EXISTS customer_note text,
  ADD COLUMN IF NOT EXISTS tags text,
  ADD COLUMN IF NOT EXISTS locale text,
  ADD COLUMN IF NOT EXISTS account_state text,
  ADD COLUMN IF NOT EXISTS spend_currency text;

COMMENT ON COLUMN public.shopify_customers.account_state IS 'Shopify Customer.state (e.g. ENABLED, INVITED)';

ALTER TABLE public.shopify_orders
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS currency_code text,
  ADD COLUMN IF NOT EXISTS subtotal numeric,
  ADD COLUMN IF NOT EXISTS total_tax numeric,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS order_note text,
  ADD COLUMN IF NOT EXISTS tags text,
  ADD COLUMN IF NOT EXISTS test_order boolean DEFAULT false;

ALTER TABLE public.shopify_order_items
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS shopify_line_item_id text,
  ADD COLUMN IF NOT EXISTS shopify_variant_gid text;

ALTER TABLE public.shopify_products
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS handle text,
  ADD COLUMN IF NOT EXISTS description_html text,
  ADD COLUMN IF NOT EXISTS tags text;
