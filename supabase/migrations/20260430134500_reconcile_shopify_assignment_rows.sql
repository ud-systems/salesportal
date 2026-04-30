-- Reconcile Shopify-derived assignment rows so historical reassignment drift is removed.
-- Preserves non-Shopify/manual assignment rows by only touching sources managed by sync/webhooks.

DELETE FROM public.salesperson_customer_assignments
WHERE source IN ('sp_assigned', 'referred_by');

INSERT INTO public.salesperson_customer_assignments (customer_id, salesperson_user_id, source)
SELECT
  c.id,
  ur.user_id,
  'sp_assigned'
FROM public.shopify_customers c
INNER JOIN public.user_roles ur
  ON ur.role = 'salesperson'
 AND lower(trim(coalesce(ur.salesperson_name, ''))) = lower(trim(coalesce(c.sp_assigned, '')))
WHERE coalesce(trim(c.sp_assigned), '') NOT IN ('', 'Unassigned', 'unassigned')
  AND coalesce(trim(ur.salesperson_name), '') <> ''
ON CONFLICT (customer_id, salesperson_user_id)
DO UPDATE SET source = EXCLUDED.source;

INSERT INTO public.salesperson_customer_assignments (customer_id, salesperson_user_id, source)
SELECT
  c.id,
  ur.user_id,
  'referred_by'
FROM public.shopify_customers c
INNER JOIN public.user_roles ur
  ON ur.role = 'salesperson'
 AND lower(trim(coalesce(ur.salesperson_name, ''))) = lower(trim(coalesce(c.referred_by, '')))
WHERE coalesce(trim(c.referred_by), '') <> ''
  AND lower(trim(coalesce(c.referred_by, ''))) NOT IN (
    'no referrer',
    'none',
    'n a',
    'na',
    'not applicable',
    'no referral',
    'no ref'
  )
  AND coalesce(trim(ur.salesperson_name), '') <> ''
ON CONFLICT (customer_id, salesperson_user_id)
DO NOTHING;

-- Keep display field aligned with assignment identity model for filters and UI.
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
SET sp_assigned = COALESCE(r.salesperson_name, 'Unassigned')
FROM (
  SELECT customer_id, salesperson_name
  FROM ranked
  WHERE rn = 1
) r
WHERE c.id = r.customer_id;

UPDATE public.shopify_customers c
SET sp_assigned = 'Unassigned'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.salesperson_customer_assignments a
  WHERE a.customer_id = c.id
);
