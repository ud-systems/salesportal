-- Speed up customers/orders/products filter and search paths used by list pages.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Orders scoped filtering + sorting
CREATE INDEX IF NOT EXISTS idx_shopify_orders_created_at ON public.shopify_orders (shopify_created_at);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_financial_status ON public.shopify_orders (financial_status);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_fulfillment_status ON public.shopify_orders (fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer_id ON public.shopify_orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_shopify_customer_id ON public.shopify_orders (shopify_customer_id);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_order_number_trgm ON public.shopify_orders USING gin (lower(coalesce(order_number, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer_name_trgm ON public.shopify_orders USING gin (lower(coalesce(customer_name, '')) gin_trgm_ops);

-- Customers scoped filtering + sorting
CREATE INDEX IF NOT EXISTS idx_shopify_customers_created_at ON public.shopify_customers (shopify_created_at);
CREATE INDEX IF NOT EXISTS idx_shopify_customers_city ON public.shopify_customers (city);
CREATE INDEX IF NOT EXISTS idx_shopify_customers_sp_assigned ON public.shopify_customers (sp_assigned);
CREATE INDEX IF NOT EXISTS idx_shopify_customers_referred_by ON public.shopify_customers (referred_by);
CREATE INDEX IF NOT EXISTS idx_shopify_customers_name_trgm ON public.shopify_customers USING gin (lower(coalesce(name, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_shopify_customers_email_trgm ON public.shopify_customers USING gin (lower(coalesce(email, '')) gin_trgm_ops);

-- Hierarchy/scope joins
CREATE INDEX IF NOT EXISTS idx_sales_hierarchy_edges_leader ON public.sales_hierarchy_edges (leader_user_id, leader_role, member_user_id);
CREATE INDEX IF NOT EXISTS idx_salesperson_customer_assignments_sp_customer ON public.salesperson_customer_assignments (salesperson_user_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user_role ON public.user_roles (user_id, role);
CREATE INDEX IF NOT EXISTS idx_user_roles_salesperson_name_trgm ON public.user_roles USING gin (lower(coalesce(salesperson_name, '')) gin_trgm_ops);

-- Products page filtering/search
CREATE INDEX IF NOT EXISTS idx_shopify_products_status ON public.shopify_products (status);
CREATE INDEX IF NOT EXISTS idx_shopify_products_updated_at ON public.shopify_products (updated_at);
CREATE INDEX IF NOT EXISTS idx_shopify_products_created_at ON public.shopify_products (created_at);
CREATE INDEX IF NOT EXISTS idx_shopify_products_title_trgm ON public.shopify_products USING gin (lower(coalesce(title, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_shopify_products_vendor_trgm ON public.shopify_products USING gin (lower(coalesce(vendor, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_shopify_variants_product_id ON public.shopify_variants (product_id);
