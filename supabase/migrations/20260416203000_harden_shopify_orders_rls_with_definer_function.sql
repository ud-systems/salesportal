-- Harden shopify_orders SELECT RLS by routing scope checks through one
-- SECURITY DEFINER function. This avoids heavy nested-policy joins in REST list calls.

CREATE OR REPLACE FUNCTION public.can_view_shopify_order(
  _viewer_user_id UUID,
  _customer_id UUID,
  _shopify_customer_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  scoped_user_ids UUID[];
BEGIN
  IF _viewer_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Admin always sees all orders.
  IF public.has_role(_viewer_user_id, 'admin') THEN
    RETURN TRUE;
  END IF;

  -- Scope by role.
  IF public.has_role(_viewer_user_id, 'salesperson') THEN
    scoped_user_ids := ARRAY[_viewer_user_id]::uuid[];
  ELSIF public.has_role(_viewer_user_id, 'manager')
     OR public.has_role(_viewer_user_id, 'supervisor') THEN
    scoped_user_ids := coalesce(
      public.get_user_scope_user_ids(_viewer_user_id),
      ARRAY[_viewer_user_id]::uuid[]
    );
  ELSE
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.salesperson_customer_assignments a
    LEFT JOIN public.shopify_customers c ON c.id = a.customer_id
    WHERE a.salesperson_user_id = ANY(scoped_user_ids)
      AND (
        (_customer_id IS NOT NULL AND a.customer_id = _customer_id)
        OR (
          _customer_id IS NULL
          AND _shopify_customer_id IS NOT NULL
          AND c.shopify_customer_id IS NOT NULL
          AND c.shopify_customer_id = _shopify_customer_id
        )
      )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_view_shopify_order(UUID, UUID, TEXT) TO authenticated, service_role;

-- Replace overlapping policies with one deterministic policy.
DROP POLICY IF EXISTS "Admins see all orders" ON public.shopify_orders;
DROP POLICY IF EXISTS "Salespersons see orders of assigned customers" ON public.shopify_orders;
DROP POLICY IF EXISTS "Leaders see scoped orders" ON public.shopify_orders;
DROP POLICY IF EXISTS "Scoped users see allowed orders" ON public.shopify_orders;

CREATE POLICY "Scoped users see allowed orders"
  ON public.shopify_orders
  FOR SELECT
  TO authenticated
  USING (
    public.can_view_shopify_order(
      auth.uid(),
      shopify_orders.customer_id,
      shopify_orders.shopify_customer_id
    )
  );
