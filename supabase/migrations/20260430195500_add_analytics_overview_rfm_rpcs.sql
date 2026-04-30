-- Analytics overview RPCs for active buyers, registrations, and RFM group chart.

CREATE OR REPLACE FUNCTION public.get_analytics_overview_kpis(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  active_buyers_count BIGINT,
  registrations_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  WITH viewer_flags AS (
    SELECT public.has_role(auth.uid(), 'admin') AS is_admin
  ),
  scope_users AS (
    SELECT unnest(coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])) AS user_id
  ),
  scope_names AS (
    SELECT DISTINCT lower(trim(ur.salesperson_name)) AS salesperson_name_norm
    FROM public.user_roles ur
    INNER JOIN scope_users su ON su.user_id = ur.user_id
    WHERE ur.salesperson_name IS NOT NULL
      AND btrim(ur.salesperson_name) <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id, c.shopify_created_at
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id, c.shopify_created_at
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (
        EXISTS (
          SELECT 1
          FROM public.salesperson_customer_assignments a
          INNER JOIN scope_users su ON su.user_id = a.salesperson_user_id
          WHERE a.customer_id = c.id
        )
        OR EXISTS (
          SELECT 1
          FROM scope_names sn
          WHERE sn.salesperson_name_norm = lower(trim(coalesce(c.sp_assigned, '')))
             OR sn.salesperson_name_norm = lower(trim(coalesce(c.referred_by, '')))
        )
      )
  ),
  active_buyers AS (
    SELECT count(DISTINCT sc.customer_id)::bigint AS count_active
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id = sc.customer_id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND sc.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = sc.shopify_customer_id
      )
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  registrations AS (
    SELECT count(DISTINCT sc.customer_id)::bigint AS count_reg
    FROM scoped_customers sc
    WHERE (_from_iso IS NULL OR sc.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR sc.shopify_created_at <= _to_iso)
  )
  SELECT
    coalesce((SELECT count_active FROM active_buyers), 0)::bigint AS active_buyers_count,
    coalesce((SELECT count_reg FROM registrations), 0)::bigint AS registrations_count;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_rfm_group_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  rfm_group TEXT,
  customers_count BIGINT,
  active_buyers_count BIGINT,
  revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  WITH viewer_flags AS (
    SELECT public.has_role(auth.uid(), 'admin') AS is_admin
  ),
  scope_users AS (
    SELECT unnest(coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])) AS user_id
  ),
  scope_names AS (
    SELECT DISTINCT lower(trim(ur.salesperson_name)) AS salesperson_name_norm
    FROM public.user_roles ur
    INNER JOIN scope_users su ON su.user_id = ur.user_id
    WHERE ur.salesperson_name IS NOT NULL
      AND btrim(ur.salesperson_name) <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id, coalesce(c.rfm_group, 'Unclassified') AS rfm_group
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id, coalesce(c.rfm_group, 'Unclassified') AS rfm_group
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (
        EXISTS (
          SELECT 1
          FROM public.salesperson_customer_assignments a
          INNER JOIN scope_users su ON su.user_id = a.salesperson_user_id
          WHERE a.customer_id = c.id
        )
        OR EXISTS (
          SELECT 1
          FROM scope_names sn
          WHERE sn.salesperson_name_norm = lower(trim(coalesce(c.sp_assigned, '')))
             OR sn.salesperson_name_norm = lower(trim(coalesce(c.referred_by, '')))
        )
      )
  ),
  scoped_orders AS (
    SELECT DISTINCT
      o.id,
      sc.customer_id,
      sc.rfm_group,
      coalesce(o.total, 0)::numeric(14,2) AS total
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id = sc.customer_id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND sc.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = sc.shopify_customer_id
      )
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  all_groups AS (
    SELECT
      sc.rfm_group,
      count(DISTINCT sc.customer_id)::bigint AS customers_count
    FROM scoped_customers sc
    GROUP BY sc.rfm_group
  ),
  active_groups AS (
    SELECT
      so.rfm_group,
      count(DISTINCT so.customer_id)::bigint AS active_buyers_count,
      coalesce(sum(so.total), 0)::numeric(14,2) AS revenue
    FROM scoped_orders so
    GROUP BY so.rfm_group
  )
  SELECT
    ag.rfm_group::text,
    ag.customers_count,
    coalesce(act.active_buyers_count, 0)::bigint AS active_buyers_count,
    coalesce(act.revenue, 0)::numeric(14,2) AS revenue
  FROM all_groups ag
  LEFT JOIN active_groups act ON act.rfm_group = ag.rfm_group
  ORDER BY ag.customers_count DESC, ag.rfm_group ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_analytics_overview_kpis(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_analytics_rfm_group_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ)
TO authenticated, service_role;
