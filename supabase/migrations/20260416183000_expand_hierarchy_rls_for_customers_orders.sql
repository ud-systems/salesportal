-- Expand RLS visibility for hierarchy leaders (manager/supervisor)
-- so they can access customers/orders assigned to salespeople in their scope.

DROP POLICY IF EXISTS "Leaders see scoped customers" ON public.shopify_customers;
CREATE POLICY "Leaders see scoped customers"
  ON public.shopify_customers
  FOR SELECT
  TO authenticated
  USING (
    (
      public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'supervisor')
    )
    AND EXISTS (
      SELECT 1
      FROM public.salesperson_customer_assignments a
      WHERE a.customer_id = shopify_customers.id
        AND a.salesperson_user_id = ANY(
          coalesce(
            public.get_user_scope_user_ids(auth.uid()),
            ARRAY[auth.uid()]::uuid[]
          )
        )
    )
  );

DROP POLICY IF EXISTS "Leaders see scoped orders" ON public.shopify_orders;
CREATE POLICY "Leaders see scoped orders"
  ON public.shopify_orders
  FOR SELECT
  TO authenticated
  USING (
    (
      public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'supervisor')
    )
    AND EXISTS (
      SELECT 1
      FROM public.salesperson_customer_assignments a
      INNER JOIN public.shopify_customers c ON c.id = a.customer_id
      WHERE a.salesperson_user_id = ANY(
        coalesce(
          public.get_user_scope_user_ids(auth.uid()),
          ARRAY[auth.uid()]::uuid[]
        )
      )
      AND (
        shopify_orders.customer_id = c.id
        OR (
          shopify_orders.customer_id IS NULL
          AND shopify_orders.shopify_customer_id IS NOT NULL
          AND c.shopify_customer_id IS NOT NULL
          AND shopify_orders.shopify_customer_id = c.shopify_customer_id
        )
      )
    )
  );
