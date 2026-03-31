-- Keep `shopify_customers.sp_assigned` aligned with `salesperson_customer_assignments`
-- so UI filters ("Assigned/Unassigned") reflect the identity-based assignment model.

-- Reset to unassigned first.
UPDATE public.shopify_customers
SET sp_assigned = 'Unassigned';

-- Prefer assignments created from `sp_assigned` metafield over `referred_by` when both exist.
WITH ranked AS (
  SELECT
    a.customer_id,
    ur.salesperson_name,
    ROW_NUMBER() OVER (
      PARTITION BY a.customer_id
      ORDER BY
        CASE WHEN a.source = 'sp_assigned' THEN 1 ELSE 2 END,
        a.created_at DESC
    ) AS rn
  FROM public.salesperson_customer_assignments a
  INNER JOIN public.user_roles ur
    ON ur.user_id = a.salesperson_user_id
  WHERE ur.role = 'salesperson'
    AND ur.salesperson_name IS NOT NULL
    AND btrim(ur.salesperson_name) <> ''
)
UPDATE public.shopify_customers c
SET sp_assigned = r.salesperson_name
FROM ranked r
WHERE r.rn = 1
  AND r.customer_id = c.id;

