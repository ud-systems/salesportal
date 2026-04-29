-- Canonical financial breakdown RPCs for transparent KPI math.

CREATE OR REPLACE FUNCTION public.normalize_financial_status(_status TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN _status IS NULL OR btrim(_status) = '' THEN 'unknown'
    WHEN lower(_status) IN ('paid', 'partially_paid') THEN lower(_status)
    WHEN lower(_status) IN ('pending', 'authorized') THEN lower(_status)
    WHEN lower(_status) IN ('refunded', 'partially_refunded', 'voided') THEN lower(_status)
    ELSE lower(_status)
  END
$$;

CREATE OR REPLACE FUNCTION public.get_scope_financial_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  customers_count BIGINT,
  orders_total_count BIGINT,
  orders_paid_count BIGINT,
  orders_pending_count BIGINT,
  orders_refunded_count BIGINT,
  gross_revenue NUMERIC(14,2),
  refunded_amount NUMERIC(14,2),
  net_revenue NUMERIC(14,2),
  avg_order_gross NUMERIC(14,2),
  avg_order_net NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scope_users AS (
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
    WHERE public.has_role(auth.uid(), 'admin')
    UNION
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    WHERE NOT public.has_role(auth.uid(), 'admin')
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
  filtered_scoped_customers AS (
    SELECT sc.customer_id
    FROM scoped_customers sc
    INNER JOIN public.shopify_customers c ON c.id = sc.customer_id
    WHERE (_from_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) <= _to_iso)
  ),
  scoped_orders AS (
    SELECT DISTINCT
      o.id,
      coalesce(o.total, 0)::numeric AS total,
      public.normalize_financial_status(o.financial_status) AS status_norm
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
  sums AS (
    SELECT
      count(*)::bigint AS c_orders_total,
      count(*) FILTER (WHERE status_norm IN ('paid', 'partially_paid'))::bigint AS c_orders_paid,
      count(*) FILTER (WHERE status_norm IN ('pending', 'authorized'))::bigint AS c_orders_pending,
      count(*) FILTER (WHERE status_norm IN ('refunded', 'partially_refunded', 'voided'))::bigint AS c_orders_refunded,
      coalesce(sum(total), 0)::numeric(14,2) AS c_gross_revenue,
      coalesce(sum(CASE WHEN status_norm IN ('refunded', 'partially_refunded', 'voided') THEN total ELSE 0 END), 0)::numeric(14,2) AS c_refunded_amount
    FROM scoped_orders
  )
  SELECT
    (SELECT count(*)::bigint FROM filtered_scoped_customers) AS customers_count,
    s.c_orders_total AS orders_total_count,
    s.c_orders_paid AS orders_paid_count,
    s.c_orders_pending AS orders_pending_count,
    s.c_orders_refunded AS orders_refunded_count,
    s.c_gross_revenue AS gross_revenue,
    s.c_refunded_amount AS refunded_amount,
    (s.c_gross_revenue - s.c_refunded_amount)::numeric(14,2) AS net_revenue,
    CASE
      WHEN s.c_orders_total > 0 THEN round((s.c_gross_revenue / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_gross,
    CASE
      WHEN s.c_orders_total > 0 THEN round(((s.c_gross_revenue - s.c_refunded_amount) / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net
  FROM sums s;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_financial_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_salesperson_financial_breakdown_rows(
  _leader_user_id UUID DEFAULT NULL,
  _leader_role TEXT DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  salesperson_user_id UUID,
  salesperson_name TEXT,
  customers_count BIGINT,
  orders_total_count BIGINT,
  orders_paid_count BIGINT,
  orders_pending_count BIGINT,
  orders_refunded_count BIGINT,
  gross_revenue NUMERIC(14,2),
  refunded_amount NUMERIC(14,2),
  net_revenue NUMERIC(14,2),
  avg_order_gross NUMERIC(14,2),
  avg_order_net NUMERIC(14,2)
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
      coalesce(o.total, 0)::numeric AS total,
      public.normalize_financial_status(o.financial_status) AS status_norm
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o ON o.customer_id = ac.customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
    UNION
    SELECT
      ac.salesperson_user_id,
      o.id AS order_id,
      coalesce(o.total, 0)::numeric AS total,
      public.normalize_financial_status(o.financial_status) AS status_norm
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND ac.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = ac.shopify_customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  order_rollup AS (
    SELECT
      om.salesperson_user_id,
      count(DISTINCT om.order_id)::bigint AS orders_total_count,
      count(DISTINCT om.order_id) FILTER (WHERE om.status_norm IN ('paid', 'partially_paid'))::bigint AS orders_paid_count,
      count(DISTINCT om.order_id) FILTER (WHERE om.status_norm IN ('pending', 'authorized'))::bigint AS orders_pending_count,
      count(DISTINCT om.order_id) FILTER (WHERE om.status_norm IN ('refunded', 'partially_refunded', 'voided'))::bigint AS orders_refunded_count,
      coalesce(sum(om.total), 0)::numeric(14,2) AS gross_revenue,
      coalesce(sum(CASE WHEN om.status_norm IN ('refunded', 'partially_refunded', 'voided') THEN om.total ELSE 0 END), 0)::numeric(14,2) AS refunded_amount
    FROM (
      SELECT DISTINCT salesperson_user_id, order_id, total, status_norm
      FROM order_matches
    ) om
    GROUP BY om.salesperson_user_id
  )
  SELECT
    v.salesperson_user_id,
    v.salesperson_name,
    coalesce(cr.customers_count, 0) AS customers_count,
    coalesce(orw.orders_total_count, 0) AS orders_total_count,
    coalesce(orw.orders_paid_count, 0) AS orders_paid_count,
    coalesce(orw.orders_pending_count, 0) AS orders_pending_count,
    coalesce(orw.orders_refunded_count, 0) AS orders_refunded_count,
    coalesce(orw.gross_revenue, 0)::numeric(14,2) AS gross_revenue,
    coalesce(orw.refunded_amount, 0)::numeric(14,2) AS refunded_amount,
    (coalesce(orw.gross_revenue, 0) - coalesce(orw.refunded_amount, 0))::numeric(14,2) AS net_revenue,
    CASE
      WHEN coalesce(orw.orders_total_count, 0) > 0 THEN round((coalesce(orw.gross_revenue, 0) / orw.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_gross,
    CASE
      WHEN coalesce(orw.orders_total_count, 0) > 0 THEN round(((coalesce(orw.gross_revenue, 0) - coalesce(orw.refunded_amount, 0)) / orw.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net
  FROM visibility_scope v
  LEFT JOIN customer_rollup cr ON cr.salesperson_user_id = v.salesperson_user_id
  LEFT JOIN order_rollup orw ON orw.salesperson_user_id = v.salesperson_user_id
  ORDER BY coalesce(orw.gross_revenue, 0) DESC, v.salesperson_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_salesperson_financial_breakdown_rows(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
