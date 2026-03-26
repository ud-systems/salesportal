-- Salesperson ↔ customer assignments (identity-based) + tightened RLS

CREATE TABLE IF NOT EXISTS public.salesperson_customer_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.shopify_customers(id) ON DELETE CASCADE,
  salesperson_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, salesperson_user_id)
);

CREATE INDEX IF NOT EXISTS idx_salesperson_assignments_salesperson
  ON public.salesperson_customer_assignments(salesperson_user_id);

CREATE INDEX IF NOT EXISTS idx_salesperson_assignments_customer
  ON public.salesperson_customer_assignments(customer_id);

ALTER TABLE public.salesperson_customer_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins full access to salesperson_customer_assignments"
  ON public.salesperson_customer_assignments
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Salespersons can view own customer assignments"
  ON public.salesperson_customer_assignments
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'salesperson')
    AND salesperson_user_id = auth.uid()
  );

-- Backfill from existing string fields (case-insensitive trim)
INSERT INTO public.salesperson_customer_assignments (customer_id, salesperson_user_id, source)
SELECT c.id, ur.user_id, 'sp_assigned'
FROM public.shopify_customers c
INNER JOIN public.user_roles ur
  ON ur.role = 'salesperson'
 AND lower(trim(coalesce(ur.salesperson_name, ''))) = lower(trim(coalesce(c.sp_assigned, '')))
WHERE coalesce(trim(c.sp_assigned), '') NOT IN ('', 'Unassigned', 'unassigned')
  AND coalesce(trim(ur.salesperson_name), '') <> ''
ON CONFLICT (customer_id, salesperson_user_id) DO NOTHING;

INSERT INTO public.salesperson_customer_assignments (customer_id, salesperson_user_id, source)
SELECT c.id, ur.user_id, 'referred_by'
FROM public.shopify_customers c
INNER JOIN public.user_roles ur
  ON ur.role = 'salesperson'
 AND lower(trim(coalesce(ur.salesperson_name, ''))) = lower(trim(coalesce(c.referred_by, '')))
WHERE coalesce(trim(c.referred_by), '') <> ''
  AND coalesce(trim(ur.salesperson_name), '') <> ''
ON CONFLICT (customer_id, salesperson_user_id) DO NOTHING;

-- Customers: scope salesperson by assignment rows (not fragile name equality on sp_assigned alone)
DROP POLICY IF EXISTS "Salespersons see assigned customers" ON public.shopify_customers;

CREATE POLICY "Salespersons see assigned customers"
  ON public.shopify_customers
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'salesperson')
    AND EXISTS (
      SELECT 1 FROM public.salesperson_customer_assignments a
      WHERE a.customer_id = shopify_customers.id
        AND a.salesperson_user_id = auth.uid()
    )
  );

-- Orders: salesperson sees rows visible via parent table RLS when using subquery pattern
DROP POLICY IF EXISTS "Salespersons see orders of assigned customers" ON public.shopify_orders;

CREATE POLICY "Salespersons see orders of assigned customers"
  ON public.shopify_orders
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'salesperson')
    AND EXISTS (
      SELECT 1 FROM public.salesperson_customer_assignments a
      INNER JOIN public.shopify_customers cust ON cust.id = a.customer_id
      WHERE a.salesperson_user_id = auth.uid()
        AND (
          shopify_orders.customer_id = cust.id
          OR (
            shopify_orders.customer_id IS NULL
            AND shopify_orders.shopify_customer_id IS NOT NULL
            AND shopify_orders.shopify_customer_id = cust.shopify_customer_id
          )
        )
    )
  );

-- Order items: visibility follows parent order (shopify_orders RLS applies in subquery)
DROP POLICY IF EXISTS "Salespersons see their order items" ON public.shopify_order_items;

CREATE POLICY "Salespersons see their order items"
  ON public.shopify_order_items
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'salesperson')
    AND EXISTS (
      SELECT 1 FROM public.shopify_orders o
      WHERE o.id = shopify_order_items.order_id
    )
  );

-- Purchase orders: link to originating Shopify order for row-level scope
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS shopify_order_id UUID REFERENCES public.shopify_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_shopify_order_id
  ON public.purchase_orders(shopify_order_id);

UPDATE public.purchase_orders po
SET shopify_order_id = o.id
FROM public.shopify_orders o
WHERE po.shopify_order_id IS NULL
  AND po.po_number IS NOT NULL
  AND o.order_number IS NOT NULL
  AND (
    po.po_number = 'PO-' || o.order_number
    OR po.po_number = 'PO-' || trim(both '#' from o.order_number)
  );

DROP POLICY IF EXISTS "Authenticated users can view purchase orders" ON public.purchase_orders;

CREATE POLICY "Admins can view all purchase orders"
  ON public.purchase_orders
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Salespersons view purchase orders for accessible orders"
  ON public.purchase_orders
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'salesperson')
    AND shopify_order_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.shopify_orders o
      WHERE o.id = purchase_orders.shopify_order_id
    )
  );
