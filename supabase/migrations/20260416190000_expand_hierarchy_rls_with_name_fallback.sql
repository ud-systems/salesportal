-- Expand hierarchy RLS with name-based fallback for leader-owned records.
-- This ensures manager/supervisor visibility includes:
-- 1) assignment-scoped records (identity model)
-- 2) records where customer ownership strings match scoped users' salesperson_name
--    (sp_assigned / referred_by), useful for leader-owned portfolios.

CREATE INDEX IF NOT EXISTS idx_shopify_customers_sp_assigned_lower
  ON public.shopify_customers (lower(trim(coalesce(sp_assigned, ''))));

CREATE INDEX IF NOT EXISTS idx_shopify_customers_referred_by_lower
  ON public.shopify_customers (lower(trim(coalesce(referred_by, ''))));

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
    AND (
      -- Preferred identity-based mapping via assignments
      EXISTS (
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
      OR
      -- Fallback string-based ownership for scoped users
      EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = ANY(
          coalesce(
            public.get_user_scope_user_ids(auth.uid()),
            ARRAY[auth.uid()]::uuid[]
          )
        )
          AND ur.salesperson_name IS NOT NULL
          AND btrim(ur.salesperson_name) <> ''
          AND (
            lower(trim(coalesce(shopify_customers.sp_assigned, ''))) = lower(trim(ur.salesperson_name))
            OR lower(trim(coalesce(shopify_customers.referred_by, ''))) = lower(trim(ur.salesperson_name))
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
      FROM public.shopify_customers c
      WHERE
        (
          shopify_orders.customer_id = c.id
          OR (
            shopify_orders.customer_id IS NULL
            AND shopify_orders.shopify_customer_id IS NOT NULL
            AND c.shopify_customer_id IS NOT NULL
            AND shopify_orders.shopify_customer_id = c.shopify_customer_id
          )
        )
        AND (
          -- Assignment-based scoped ownership
          EXISTS (
            SELECT 1
            FROM public.salesperson_customer_assignments a
            WHERE a.customer_id = c.id
              AND a.salesperson_user_id = ANY(
                coalesce(
                  public.get_user_scope_user_ids(auth.uid()),
                  ARRAY[auth.uid()]::uuid[]
                )
              )
          )
          OR
          -- Name-based fallback scoped ownership
          EXISTS (
            SELECT 1
            FROM public.user_roles ur
            WHERE ur.user_id = ANY(
              coalesce(
                public.get_user_scope_user_ids(auth.uid()),
                ARRAY[auth.uid()]::uuid[]
              )
            )
              AND ur.salesperson_name IS NOT NULL
              AND btrim(ur.salesperson_name) <> ''
              AND (
                lower(trim(coalesce(c.sp_assigned, ''))) = lower(trim(ur.salesperson_name))
                OR lower(trim(coalesce(c.referred_by, ''))) = lower(trim(ur.salesperson_name))
              )
          )
        )
    )
  );
