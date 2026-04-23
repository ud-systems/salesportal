-- Revenue discrepancy fix:
-- 1) Exclude test orders from revenue KPIs.
-- 2) Exclude refunded/partially_refunded/voided orders from revenue KPIs.
-- 3) Keep scope logic unchanged; only tighten monetary inclusion rules.

CREATE OR REPLACE FUNCTION public.get_scope_order_metrics(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  orders_count BIGINT,
  customers_count BIGINT,
  revenue NUMERIC(14,2),
  avg_order_value NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
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
      coalesce(o.total, 0)::numeric AS total
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
      AND coalesce(lower(o.financial_status), '') NOT IN ('refunded', 'partially_refunded', 'voided')
  ),
  filtered_scoped_customers AS (
    SELECT sc.customer_id
    FROM scoped_customers sc
    INNER JOIN public.shopify_customers c ON c.id = sc.customer_id
    WHERE (_from_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) <= _to_iso)
  ),
  sums AS (
    SELECT
      count(*)::bigint AS c_orders,
      coalesce(sum(total), 0)::numeric(14,2) AS c_revenue
    FROM scoped_orders
  )
  SELECT
    s.c_orders AS orders_count,
    (SELECT count(*)::bigint FROM filtered_scoped_customers) AS customers_count,
    s.c_revenue AS revenue,
    CASE
      WHEN s.c_orders > 0 THEN round((s.c_revenue / s.c_orders)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_value
  FROM sums s;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_order_metrics(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_scope_order_timeseries(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _bucket TEXT DEFAULT 'month'
)
RETURNS TABLE (
  bucket_key TEXT,
  bucket_label TEXT,
  orders_count BIGINT,
  revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
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
      o.shopify_created_at,
      coalesce(o.total, 0)::numeric AS total
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
      AND coalesce(lower(o.financial_status), '') NOT IN ('refunded', 'partially_refunded', 'voided')
  ),
  bucketed AS (
    SELECT
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', o.shopify_created_at), 'YYYY-MM-DD')
        ELSE to_char(date_trunc('month', o.shopify_created_at), 'YYYY-MM')
      END AS bucket_key,
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', o.shopify_created_at), 'DD Mon')
        ELSE to_char(date_trunc('month', o.shopify_created_at), 'Mon YYYY')
      END AS bucket_label,
      count(*)::bigint AS orders_count,
      coalesce(sum(o.total), 0)::numeric(14,2) AS revenue
    FROM scoped_orders o
    GROUP BY 1, 2
  )
  SELECT
    b.bucket_key,
    b.bucket_label,
    b.orders_count,
    b.revenue
  FROM bucketed b
  ORDER BY b.bucket_key ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_order_timeseries(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_salesperson_performance_rows(
  _leader_user_id UUID DEFAULT NULL,
  _leader_role TEXT DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  salesperson_user_id UUID,
  salesperson_name TEXT,
  customers_count BIGINT,
  orders_count BIGINT,
  revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH salesperson_base AS (
    SELECT
      ur.user_id AS salesperson_user_id,
      COALESCE(NULLIF(max(ur.salesperson_name), ''), 'Salesperson') AS salesperson_name
    FROM public.user_roles ur
    WHERE ur.role = 'salesperson'
    GROUP BY ur.user_id
  ),
  visibility_scope AS (
    SELECT sb.salesperson_user_id, sb.salesperson_name
    FROM salesperson_base sb
    WHERE
      public.has_role(auth.uid(), 'admin')
      OR (
        public.has_role(auth.uid(), 'salesperson')
        AND sb.salesperson_user_id = auth.uid()
      )
      OR (
        _leader_user_id IS NOT NULL
        AND auth.uid() = _leader_user_id
        AND COALESCE(_leader_role, '') IN ('manager', 'supervisor')
        AND (
          (_leader_role = 'manager' AND public.has_role(auth.uid(), 'manager'))
          OR (_leader_role = 'supervisor' AND public.has_role(auth.uid(), 'supervisor'))
        )
        AND sb.salesperson_user_id IN (
          SELECT e.member_user_id
          FROM public.sales_hierarchy_edges e
          WHERE e.leader_user_id = _leader_user_id
            AND e.leader_role::text = _leader_role
        )
      )
  ),
  assignment_customers AS (
    SELECT DISTINCT
      a.salesperson_user_id,
      a.customer_id,
      c.shopify_customer_id,
      c.shopify_created_at,
      c.created_at
    FROM public.salesperson_customer_assignments a
    LEFT JOIN public.shopify_customers c ON c.id = a.customer_id
  ),
  customer_rollup AS (
    SELECT
      ac.salesperson_user_id,
      count(DISTINCT ac.customer_id)::bigint AS customers_count
    FROM assignment_customers ac
    WHERE (_from_iso IS NULL OR coalesce(ac.shopify_created_at, ac.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(ac.shopify_created_at, ac.created_at) <= _to_iso)
    GROUP BY ac.salesperson_user_id
  ),
  order_matches AS (
    SELECT
      ac.salesperson_user_id,
      o.id AS order_id,
      coalesce(o.total, 0)::numeric AS total
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o ON o.customer_id = ac.customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
      AND coalesce(lower(o.financial_status), '') NOT IN ('refunded', 'partially_refunded', 'voided')
    UNION
    SELECT
      ac.salesperson_user_id,
      o.id AS order_id,
      coalesce(o.total, 0)::numeric AS total
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND ac.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = ac.shopify_customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
      AND coalesce(lower(o.financial_status), '') NOT IN ('refunded', 'partially_refunded', 'voided')
  ),
  order_rollup AS (
    SELECT
      om.salesperson_user_id,
      count(DISTINCT om.order_id)::bigint AS orders_count,
      coalesce(sum(om.total), 0)::numeric(14,2) AS revenue
    FROM order_matches om
    GROUP BY om.salesperson_user_id
  )
  SELECT
    v.salesperson_user_id,
    v.salesperson_name,
    coalesce(cr.customers_count, 0) AS customers_count,
    coalesce(orw.orders_count, 0) AS orders_count,
    coalesce(orw.revenue, 0)::numeric(14,2) AS revenue
  FROM visibility_scope v
  LEFT JOIN customer_rollup cr ON cr.salesperson_user_id = v.salesperson_user_id
  LEFT JOIN order_rollup orw ON orw.salesperson_user_id = v.salesperson_user_id
  ORDER BY coalesce(orw.revenue, 0) DESC, v.salesperson_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_salesperson_performance_rows(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_supervisor_selected_manager_timeseries(
  _supervisor_user_id UUID,
  _manager_user_ids UUID[] DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _bucket TEXT DEFAULT 'month'
)
RETURNS TABLE (
  bucket_key TEXT,
  bucket_label TEXT,
  orders_count BIGINT,
  revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH authz AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (auth.uid() = _supervisor_user_id AND public.has_role(auth.uid(), 'supervisor')) AS is_self_supervisor
  ),
  allowed_managers AS (
    SELECT DISTINCT e.member_user_id AS manager_user_id
    FROM public.sales_hierarchy_edges e
    CROSS JOIN authz a
    WHERE
      e.leader_user_id = _supervisor_user_id
      AND e.leader_role = 'supervisor'
      AND (a.is_admin OR a.is_self_supervisor)
  ),
  target_managers AS (
    SELECT am.manager_user_id
    FROM allowed_managers am
    WHERE
      _manager_user_ids IS NULL
      OR cardinality(_manager_user_ids) = 0
      OR am.manager_user_id = ANY(_manager_user_ids)
  ),
  scoped_salespeople AS (
    SELECT DISTINCT e.member_user_id AS salesperson_user_id
    FROM public.sales_hierarchy_edges e
    INNER JOIN target_managers tm ON tm.manager_user_id = e.leader_user_id
    WHERE e.leader_role = 'manager'
  ),
  scoped_customers AS (
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.salesperson_customer_assignments a
    INNER JOIN scoped_salespeople sp ON sp.salesperson_user_id = a.salesperson_user_id
    INNER JOIN public.shopify_customers c ON c.id = a.customer_id
  ),
  scoped_orders AS (
    SELECT DISTINCT
      o.id,
      o.shopify_created_at,
      coalesce(o.total, 0)::numeric AS total
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
      AND coalesce(lower(o.financial_status), '') NOT IN ('refunded', 'partially_refunded', 'voided')
  ),
  bucketed AS (
    SELECT
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', o.shopify_created_at), 'YYYY-MM-DD')
        ELSE to_char(date_trunc('month', o.shopify_created_at), 'YYYY-MM')
      END AS bucket_key,
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', o.shopify_created_at), 'DD Mon')
        ELSE to_char(date_trunc('month', o.shopify_created_at), 'Mon YYYY')
      END AS bucket_label,
      count(*)::bigint AS orders_count,
      coalesce(sum(o.total), 0)::numeric(14,2) AS revenue
    FROM scoped_orders o
    GROUP BY 1, 2
  )
  SELECT
    b.bucket_key,
    b.bucket_label,
    b.orders_count,
    b.revenue
  FROM bucketed b
  ORDER BY b.bucket_key ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_supervisor_selected_manager_timeseries(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_manager_selected_salespeople_timeseries(
  _manager_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _bucket TEXT DEFAULT 'month'
)
RETURNS TABLE (
  bucket_key TEXT,
  bucket_label TEXT,
  orders_count BIGINT,
  revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH authz AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (auth.uid() = _manager_user_id AND public.has_role(auth.uid(), 'manager')) AS is_self_manager
  ),
  allowed_salespeople AS (
    SELECT DISTINCT e.member_user_id AS salesperson_user_id
    FROM public.sales_hierarchy_edges e
    CROSS JOIN authz a
    WHERE
      e.leader_user_id = _manager_user_id
      AND e.leader_role = 'manager'
      AND (a.is_admin OR a.is_self_manager)
  ),
  target_salespeople AS (
    SELECT asp.salesperson_user_id
    FROM allowed_salespeople asp
    WHERE
      _salesperson_user_ids IS NULL
      OR cardinality(_salesperson_user_ids) = 0
      OR asp.salesperson_user_id = ANY(_salesperson_user_ids)
  ),
  scoped_customers AS (
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.salesperson_customer_assignments a
    INNER JOIN target_salespeople ts ON ts.salesperson_user_id = a.salesperson_user_id
    INNER JOIN public.shopify_customers c ON c.id = a.customer_id
  ),
  scoped_orders AS (
    SELECT DISTINCT
      o.id,
      o.shopify_created_at,
      coalesce(o.total, 0)::numeric AS total
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
      AND coalesce(lower(o.financial_status), '') NOT IN ('refunded', 'partially_refunded', 'voided')
  ),
  bucketed AS (
    SELECT
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', o.shopify_created_at), 'YYYY-MM-DD')
        ELSE to_char(date_trunc('month', o.shopify_created_at), 'YYYY-MM')
      END AS bucket_key,
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', o.shopify_created_at), 'DD Mon')
        ELSE to_char(date_trunc('month', o.shopify_created_at), 'Mon YYYY')
      END AS bucket_label,
      count(*)::bigint AS orders_count,
      coalesce(sum(o.total), 0)::numeric(14,2) AS revenue
    FROM scoped_orders o
    GROUP BY 1, 2
  )
  SELECT
    b.bucket_key,
    b.bucket_label,
    b.orders_count,
    b.revenue
  FROM bucketed b
  ORDER BY b.bucket_key ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_manager_selected_salespeople_timeseries(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated, service_role;
