-- Centralize salesperson->customer scope resolution in DB for managers/supervisors.
-- This avoids frontend-side multi-table scope stitching under RLS.

CREATE OR REPLACE FUNCTION public.get_scoped_customer_ids_for_salespeople(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  customer_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH authz AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (
        auth.uid() = _viewer_user_id
        AND (
          public.has_role(auth.uid(), 'manager')
          OR public.has_role(auth.uid(), 'supervisor')
          OR public.has_role(auth.uid(), 'salesperson')
        )
      ) AS is_self_scoped_user
  ),
  viewer_scope AS (
    SELECT unnest(
      coalesce(
        public.get_user_scope_user_ids(_viewer_user_id),
        ARRAY[_viewer_user_id]::uuid[]
      )
    ) AS user_id
  ),
  requested_salespeople AS (
    SELECT DISTINCT unnest(
      CASE
        WHEN _salesperson_user_ids IS NULL OR cardinality(_salesperson_user_ids) = 0
          THEN ARRAY[]::uuid[]
        ELSE _salesperson_user_ids
      END
    ) AS user_id
  ),
  effective_salespeople AS (
    SELECT vs.user_id
    FROM viewer_scope vs
    CROSS JOIN authz a
    WHERE a.is_admin
       OR (
         a.is_self_scoped_user
         AND (
           NOT EXISTS (SELECT 1 FROM requested_salespeople)
           OR vs.user_id IN (SELECT user_id FROM requested_salespeople)
         )
       )
  ),
  assignment_customers AS (
    SELECT DISTINCT a.customer_id
    FROM public.salesperson_customer_assignments a
    INNER JOIN effective_salespeople es ON es.user_id = a.salesperson_user_id
  ),
  owner_names AS (
    SELECT DISTINCT trim(ur.salesperson_name) AS owner_name
    FROM public.user_roles ur
    INNER JOIN effective_salespeople es ON es.user_id = ur.user_id
    WHERE coalesce(trim(ur.salesperson_name), '') <> ''
  ),
  fallback_customers AS (
    SELECT DISTINCT c.id AS customer_id
    FROM public.shopify_customers c
    INNER JOIN owner_names n
      ON lower(trim(coalesce(c.sp_assigned, ''))) = lower(n.owner_name)
      OR lower(trim(coalesce(c.referred_by, ''))) = lower(n.owner_name)
  )
  SELECT customer_id FROM assignment_customers
  UNION
  SELECT customer_id FROM fallback_customers;
$$;

GRANT EXECUTE ON FUNCTION public.get_scoped_customer_ids_for_salespeople(UUID, UUID[]) TO authenticated, service_role;
