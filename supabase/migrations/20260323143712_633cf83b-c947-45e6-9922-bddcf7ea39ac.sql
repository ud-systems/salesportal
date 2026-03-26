-- Create app_role enum
CREATE TYPE public.app_role AS ENUM ('admin', 'salesperson');

-- Create user_roles table
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  salesperson_name TEXT,
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Security definer function to check roles
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- Get salesperson name for a user
CREATE OR REPLACE FUNCTION public.get_salesperson_name(_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT salesperson_name FROM public.user_roles
  WHERE user_id = _user_id AND role = 'salesperson'
  LIMIT 1
$$;

-- RLS policies for user_roles
CREATE POLICY "Admins can view all roles" ON public.user_roles
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users can view own role" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id);

-- Shopify Customers
CREATE TABLE public.shopify_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_customer_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  city TEXT,
  store_name TEXT,
  sp_assigned TEXT,
  referred_by TEXT,
  total_orders INTEGER DEFAULT 0,
  total_revenue NUMERIC(12,2) DEFAULT 0,
  shopify_created_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE public.shopify_customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins see all customers" ON public.shopify_customers
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Salespersons see assigned customers" ON public.shopify_customers
  FOR SELECT USING (
    sp_assigned = public.get_salesperson_name(auth.uid())
  );

-- Shopify Orders
CREATE TABLE public.shopify_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_order_id TEXT UNIQUE NOT NULL,
  order_number TEXT,
  customer_id UUID REFERENCES public.shopify_customers(id) ON DELETE SET NULL,
  shopify_customer_id TEXT,
  customer_name TEXT,
  total NUMERIC(12,2) DEFAULT 0,
  financial_status TEXT,
  fulfillment_status TEXT,
  shopify_created_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE public.shopify_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins see all orders" ON public.shopify_orders
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Salespersons see orders of assigned customers" ON public.shopify_orders
  FOR SELECT USING (
    customer_id IN (
      SELECT id FROM public.shopify_customers
      WHERE sp_assigned = public.get_salesperson_name(auth.uid())
    )
  );

-- Shopify Order Items
CREATE TABLE public.shopify_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES public.shopify_orders(id) ON DELETE CASCADE NOT NULL,
  product TEXT,
  variant TEXT,
  quantity INTEGER DEFAULT 0,
  price NUMERIC(12,2) DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE public.shopify_order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins see all order items" ON public.shopify_order_items
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Salespersons see their order items" ON public.shopify_order_items
  FOR SELECT USING (
    order_id IN (
      SELECT o.id FROM public.shopify_orders o
      JOIN public.shopify_customers c ON o.customer_id = c.id
      WHERE c.sp_assigned = public.get_salesperson_name(auth.uid())
    )
  );

-- Shopify Products
CREATE TABLE public.shopify_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_product_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  vendor TEXT,
  category TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE public.shopify_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view products" ON public.shopify_products
  FOR SELECT TO authenticated USING (true);

-- Shopify Variants
CREATE TABLE public.shopify_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES public.shopify_products(id) ON DELETE CASCADE NOT NULL,
  shopify_variant_id TEXT UNIQUE NOT NULL,
  title TEXT,
  sku TEXT,
  price NUMERIC(12,2) DEFAULT 0,
  stock INTEGER DEFAULT 0,
  inventory_location TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE public.shopify_variants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view variants" ON public.shopify_variants
  FOR SELECT TO authenticated USING (true);

-- Sync Logs
CREATE TABLE public.sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  records_synced INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

ALTER TABLE public.sync_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view sync logs" ON public.sync_logs
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

-- Updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_shopify_customers_updated_at
  BEFORE UPDATE ON public.shopify_customers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_shopify_orders_updated_at
  BEFORE UPDATE ON public.shopify_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_shopify_products_updated_at
  BEFORE UPDATE ON public.shopify_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_shopify_variants_updated_at
  BEFORE UPDATE ON public.shopify_variants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_shopify_customers_sp_assigned ON public.shopify_customers(sp_assigned);
CREATE INDEX idx_shopify_orders_customer_id ON public.shopify_orders(customer_id);
CREATE INDEX idx_shopify_orders_shopify_customer_id ON public.shopify_orders(shopify_customer_id);
CREATE INDEX idx_shopify_variants_product_id ON public.shopify_variants(product_id);
CREATE INDEX idx_sync_logs_sync_type ON public.sync_logs(sync_type);