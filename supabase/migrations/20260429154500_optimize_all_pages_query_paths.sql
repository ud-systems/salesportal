-- Global query-path performance migration for all modules and roles.
-- Covers dashboard + orders + customers + products + variants + analytics list/search flows.

-- Needed for fast ILIKE / text search with GIN trigram indexes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- SHOPIFY ORDERS
-- ---------------------------------------------------------------------------
-- Frequent filters/sorts:
-- - shopify_created_at range + DESC ordering
-- - financial_status / fulfillment_status filters
-- - scoped customer joins (customer_id, shopify_customer_id)
-- - search on order_number/customer_name

CREATE INDEX IF NOT EXISTS idx_shopify_orders_created_at_desc
  ON public.shopify_orders (shopify_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_financial_status_created_at
  ON public.shopify_orders (financial_status, shopify_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_fulfillment_status_created_at
  ON public.shopify_orders (fulfillment_status, shopify_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_processed_at
  ON public.shopify_orders (processed_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_total
  ON public.shopify_orders (total DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_order_number_trgm
  ON public.shopify_orders USING gin (order_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer_name_trgm
  ON public.shopify_orders USING gin (customer_name gin_trgm_ops);

-- Non-test subset used by KPI/reporting queries
CREATE INDEX IF NOT EXISTS idx_shopify_orders_non_test_created_at
  ON public.shopify_orders (shopify_created_at DESC)
  WHERE coalesce(test_order, false) = false;

CREATE INDEX IF NOT EXISTS idx_shopify_orders_non_test_status_created_at
  ON public.shopify_orders (financial_status, shopify_created_at DESC)
  WHERE coalesce(test_order, false) = false;

-- ---------------------------------------------------------------------------
-- SHOPIFY CUSTOMERS
-- ---------------------------------------------------------------------------
-- Frequent filters/sorts:
-- - created range
-- - city, assignment state
-- - sort by total_revenue / total_orders
-- - search on name/email/city
-- - normalized owner fallback matching

CREATE INDEX IF NOT EXISTS idx_shopify_customers_created_at
  ON public.shopify_customers (shopify_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_customers_city_created_at
  ON public.shopify_customers (city, shopify_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_customers_total_revenue
  ON public.shopify_customers (total_revenue DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_customers_total_orders
  ON public.shopify_customers (total_orders DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_customers_name_trgm
  ON public.shopify_customers USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_shopify_customers_email_trgm
  ON public.shopify_customers USING gin (email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_shopify_customers_city_trgm
  ON public.shopify_customers USING gin (city gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_shopify_customers_sp_assigned_norm_perf
  ON public.shopify_customers ((lower(trim(coalesce(sp_assigned, '')))));

CREATE INDEX IF NOT EXISTS idx_shopify_customers_referred_by_norm_perf
  ON public.shopify_customers ((lower(trim(coalesce(referred_by, '')))));

-- ---------------------------------------------------------------------------
-- SHOPIFY ORDER ITEMS
-- ---------------------------------------------------------------------------
-- Frequent joins/analytics:
-- - by order_id for order details
-- - product/sku grouping and search in analytics

CREATE INDEX IF NOT EXISTS idx_shopify_order_items_order_id
  ON public.shopify_order_items (order_id);

CREATE INDEX IF NOT EXISTS idx_shopify_order_items_product
  ON public.shopify_order_items (product);

CREATE INDEX IF NOT EXISTS idx_shopify_order_items_sku
  ON public.shopify_order_items (sku);

-- ---------------------------------------------------------------------------
-- SHOPIFY PRODUCTS
-- ---------------------------------------------------------------------------
-- Frequent filters/sorts:
-- - title/vendor/category text search
-- - status filter
-- - updated_at / created_at sorting

CREATE INDEX IF NOT EXISTS idx_shopify_products_status_updated_at
  ON public.shopify_products (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_products_updated_at
  ON public.shopify_products (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_products_created_at
  ON public.shopify_products (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_products_title_trgm
  ON public.shopify_products USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_shopify_products_vendor_trgm
  ON public.shopify_products USING gin (vendor gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_shopify_products_category_trgm
  ON public.shopify_products USING gin (category gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- SHOPIFY VARIANTS
-- ---------------------------------------------------------------------------
-- Frequent filters/sorts:
-- - sku search
-- - stock and updated_at sorting
-- - location filter

CREATE INDEX IF NOT EXISTS idx_shopify_variants_sku_trgm
  ON public.shopify_variants USING gin (sku gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_shopify_variants_stock
  ON public.shopify_variants (stock ASC);

CREATE INDEX IF NOT EXISTS idx_shopify_variants_updated_at
  ON public.shopify_variants (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopify_variants_inventory_location
  ON public.shopify_variants (inventory_location);

-- ---------------------------------------------------------------------------
-- HIERARCHY / ASSIGNMENTS (used across role-scoped pages)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sp_assignments_customer_salesperson
  ON public.salesperson_customer_assignments (customer_id, salesperson_user_id);

CREATE INDEX IF NOT EXISTS idx_sp_assignments_salesperson_customer
  ON public.salesperson_customer_assignments (salesperson_user_id, customer_id);

CREATE INDEX IF NOT EXISTS idx_sales_hierarchy_edges_leader_role_member
  ON public.sales_hierarchy_edges (leader_user_id, leader_role, member_user_id);

-- ---------------------------------------------------------------------------
-- OPTIONAL STATISTICS REFRESH HINT
-- ---------------------------------------------------------------------------
-- Autovacuum typically keeps stats updated; this is a lightweight hint for
-- environments where planner stats lag after large syncs.
ANALYZE public.shopify_orders;
ANALYZE public.shopify_customers;
ANALYZE public.shopify_order_items;
ANALYZE public.shopify_products;
ANALYZE public.shopify_variants;
ANALYZE public.salesperson_customer_assignments;
ANALYZE public.sales_hierarchy_edges;
