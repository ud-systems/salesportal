-- Align KPI sums with Shopify Admin order money fields:
-- - shopify_orders.total       := Order.totalPriceSet (before returns; Shopify docs)
-- - shopify_orders.current_total := Order.currentTotalPriceSet (after returns/refunds; matches Admin totals)
-- Revenue KPIs use current totals; gross keeps pre-return sums; refunded_amount = orig − current (returns/adjustments).

ALTER TABLE public.shopify_orders
  ADD COLUMN IF NOT EXISTS current_total numeric(14,2);

COMMENT ON COLUMN public.shopify_orders.total IS 'Shopify totalPriceSet.shopMoney (order total before returns).';
COMMENT ON COLUMN public.shopify_orders.current_total IS 'Shopify currentTotalPriceSet.shopMoney (order total after returns/refunds/edits).';

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
  filtered_scoped_customers AS (
    SELECT sc.customer_id
    FROM scoped_customers sc
    INNER JOIN public.shopify_customers c ON c.id = sc.customer_id
    WHERE (_from_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(c.shopify_created_at, c.created_at) <= _to_iso)
  ),
  admin_orders AS (
    SELECT
      o.id,
      coalesce(o.total, 0)::numeric AS total_orig,
      coalesce(o.current_total, o.total, 0)::numeric AS total_curr,
      public.normalize_financial_status(o.financial_status) AS status_norm
    FROM public.shopify_orders o
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_orders_direct AS (
    SELECT DISTINCT
      o.id,
      coalesce(o.total, 0)::numeric AS total_orig,
      coalesce(o.current_total, o.total, 0)::numeric AS total_curr,
      public.normalize_financial_status(o.financial_status) AS status_norm
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_orders_fallback AS (
    SELECT DISTINCT
      o.id,
      coalesce(o.total, 0)::numeric AS total_orig,
      coalesce(o.current_total, o.total, 0)::numeric AS total_curr,
      public.normalize_financial_status(o.financial_status) AS status_norm
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_orders AS (
    SELECT DISTINCT id, total_orig, total_curr, status_norm FROM admin_orders
    UNION
    SELECT DISTINCT id, total_orig, total_curr, status_norm FROM scoped_orders_direct
    UNION
    SELECT DISTINCT id, total_orig, total_curr, status_norm FROM scoped_orders_fallback
  ),
  sums AS (
    SELECT
      count(*)::bigint AS c_orders_total,
      count(*) FILTER (WHERE status_norm IN ('paid', 'partially_paid'))::bigint AS c_orders_paid,
      count(*) FILTER (WHERE status_norm IN ('pending', 'authorized'))::bigint AS c_orders_pending,
      count(*) FILTER (WHERE status_norm IN ('refunded', 'partially_refunded', 'voided'))::bigint AS c_orders_refunded,
      coalesce(sum(total_orig), 0)::numeric(14,2) AS c_gross_revenue,
      coalesce(sum(greatest(total_orig - total_curr, 0::numeric)), 0)::numeric(14,2) AS c_refunded_amount,
      coalesce(sum(total_curr), 0)::numeric(14,2) AS c_net_revenue
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
    s.c_net_revenue AS net_revenue,
    CASE
      WHEN s.c_orders_total > 0 THEN round((s.c_gross_revenue / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_gross,
    CASE
      WHEN s.c_orders_total > 0 THEN round((s.c_net_revenue / s.c_orders_total)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net
  FROM sums s;
$$;

GRANT EXECUTE ON FUNCTION public.get_scope_financial_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

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
      coalesce(o.current_total, o.total, 0)::numeric AS order_amount
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
      coalesce(sum(order_amount), 0)::numeric(14,2) AS c_revenue
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
      coalesce(o.current_total, o.total, 0)::numeric AS order_amount
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
      coalesce(sum(o.order_amount), 0)::numeric(14,2) AS revenue
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
      coalesce(o.current_total, o.total, 0)::numeric AS total
    FROM assignment_customers ac
    INNER JOIN public.shopify_orders o ON o.customer_id = ac.customer_id
    WHERE (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
    UNION
    SELECT
      ac.salesperson_user_id,
      o.id AS order_id,
      coalesce(o.current_total, o.total, 0)::numeric AS total
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

CREATE OR REPLACE FUNCTION public.get_selected_salespeople_scope_metrics_timeseries(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _bucket TEXT DEFAULT 'month'
)
RETURNS TABLE (
  orders_count BIGINT,
  customers_count BIGINT,
  revenue NUMERIC(14,2),
  avg_order_value NUMERIC(14,2),
  orders_total_count BIGINT,
  orders_paid_count BIGINT,
  orders_pending_count BIGINT,
  orders_refunded_count BIGINT,
  gross_revenue NUMERIC(14,2),
  refunded_amount NUMERIC(14,2),
  net_revenue NUMERIC(14,2),
  avg_order_gross NUMERIC(14,2),
  avg_order_net NUMERIC(14,2),
  series JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped_customer_ids AS (
    SELECT customer_id
    FROM public.get_scoped_customer_ids_for_salespeople(
      _viewer_user_id,
      _salesperson_user_ids
    )
  ),
  scoped_customers AS (
    SELECT
      c.id AS customer_id,
      c.shopify_customer_id,
      coalesce(c.shopify_created_at, c.created_at) AS customer_created_at
    FROM public.shopify_customers c
    INNER JOIN scoped_customer_ids sci ON sci.customer_id = c.id
  ),
  filtered_customers AS (
    SELECT customer_id
    FROM scoped_customers
    WHERE (_from_iso IS NULL OR customer_created_at >= _from_iso)
      AND (_to_iso IS NULL OR customer_created_at <= _to_iso)
  ),
  order_matches AS (
    SELECT
      o.id,
      coalesce(o.total, 0)::numeric AS total_orig,
      coalesce(o.current_total, o.total, 0)::numeric AS total_curr,
      lower(trim(coalesce(o.financial_status, ''))) AS financial_status_norm,
      coalesce(o.shopify_created_at, o.created_at) AS order_created_at
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) <= _to_iso)

    UNION

    SELECT
      o.id,
      coalesce(o.total, 0)::numeric AS total_orig,
      coalesce(o.current_total, o.total, 0)::numeric AS total_curr,
      lower(trim(coalesce(o.financial_status, ''))) AS financial_status_norm,
      coalesce(o.shopify_created_at, o.created_at) AS order_created_at
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) <= _to_iso)
  ),
  scoped_orders AS (
    SELECT DISTINCT ON (id)
      id,
      total_orig,
      total_curr,
      CASE
        WHEN financial_status_norm = 'partially paid' THEN 'partially_paid'
        WHEN financial_status_norm = 'partially refunded' THEN 'partially_refunded'
        WHEN financial_status_norm = '' THEN 'pending'
        ELSE financial_status_norm
      END AS financial_status_norm,
      order_created_at
    FROM order_matches
    ORDER BY id
  ),
  order_agg AS (
    SELECT
      count(*)::bigint AS orders_total_count,
      coalesce(sum(total_orig), 0)::numeric(14,2) AS gross_revenue,
      coalesce(sum(greatest(total_orig - total_curr, 0::numeric)), 0)::numeric(14,2) AS refunded_amount,
      coalesce(sum(total_curr), 0)::numeric(14,2) AS net_sales,
      count(*) FILTER (
        WHERE financial_status_norm IN ('paid', 'partially_paid')
      )::bigint AS orders_paid_count,
      count(*) FILTER (
        WHERE financial_status_norm IN ('refunded', 'partially_refunded', 'voided')
      )::bigint AS orders_refunded_count
    FROM scoped_orders
  ),
  timeseries AS (
    SELECT
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', order_created_at), 'YYYY-MM-DD')
        ELSE to_char(date_trunc('month', order_created_at), 'YYYY-MM')
      END AS bucket_key,
      CASE
        WHEN _bucket = 'day'
          THEN to_char(date_trunc('day', order_created_at), 'DD Mon')
        ELSE to_char(date_trunc('month', order_created_at), 'Mon YYYY')
      END AS bucket_label,
      count(*)::bigint AS orders_count,
      coalesce(sum(total_curr), 0)::numeric(14,2) AS revenue
    FROM scoped_orders
    GROUP BY 1, 2
  ),
  series_json AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'label', t.bucket_label,
          'revenue', t.revenue,
          'orders', t.orders_count
        )
        ORDER BY t.bucket_key
      ),
      '[]'::jsonb
    ) AS series
    FROM timeseries t
  )
  SELECT
    oa.orders_total_count AS orders_count,
    (SELECT count(*)::bigint FROM filtered_customers) AS customers_count,
    oa.net_sales AS revenue,
    CASE
      WHEN oa.orders_total_count > 0 THEN round((oa.net_sales / oa.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_value,
    oa.orders_total_count,
    oa.orders_paid_count,
    greatest(oa.orders_total_count - oa.orders_paid_count - oa.orders_refunded_count, 0)::bigint AS orders_pending_count,
    oa.orders_refunded_count,
    oa.gross_revenue,
    oa.refunded_amount,
    oa.net_sales AS net_revenue,
    CASE
      WHEN oa.orders_total_count > 0 THEN round((oa.gross_revenue / oa.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_gross,
    CASE
      WHEN oa.orders_total_count > 0 THEN round((oa.net_sales / oa.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net,
    sj.series
  FROM order_agg oa
  CROSS JOIN series_json sj;
$$;

GRANT EXECUTE ON FUNCTION public.get_selected_salespeople_scope_metrics_timeseries(UUID, UUID[], TIMESTAMPTZ, TIMESTAMPTZ, TEXT)
TO authenticated, service_role;

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
      coalesce(o.total, 0)::numeric AS total_orig,
      coalesce(o.current_total, o.total, 0)::numeric AS total_curr,
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
      coalesce(o.total, 0)::numeric AS total_orig,
      coalesce(o.current_total, o.total, 0)::numeric AS total_curr,
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
      coalesce(sum(om.total_orig), 0)::numeric(14,2) AS gross_revenue,
      coalesce(sum(greatest(om.total_orig - om.total_curr, 0::numeric)), 0)::numeric(14,2) AS refunded_amount,
      coalesce(sum(om.total_curr), 0)::numeric(14,2) AS net_revenue
    FROM (
      SELECT DISTINCT salesperson_user_id, order_id, total_orig, total_curr, status_norm
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
    coalesce(orw.net_revenue, 0)::numeric(14,2) AS net_revenue,
    CASE
      WHEN coalesce(orw.orders_total_count, 0) > 0 THEN round((coalesce(orw.gross_revenue, 0) / orw.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_gross,
    CASE
      WHEN coalesce(orw.orders_total_count, 0) > 0 THEN round((coalesce(orw.net_revenue, 0) / orw.orders_total_count)::numeric, 2)
      ELSE 0::numeric(14,2)
    END AS avg_order_net
  FROM visibility_scope v
  LEFT JOIN customer_rollup cr ON cr.salesperson_user_id = v.salesperson_user_id
  LEFT JOIN order_rollup orw ON orw.salesperson_user_id = v.salesperson_user_id
  ORDER BY coalesce(orw.gross_revenue, 0) DESC, v.salesperson_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_salesperson_financial_breakdown_rows(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;

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
      coalesce(o.current_total, o.total, 0)::numeric AS order_amount
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
      coalesce(sum(o.order_amount), 0)::numeric(14,2) AS revenue
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
      coalesce(o.current_total, o.total, 0)::numeric AS order_amount
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
      coalesce(sum(o.order_amount), 0)::numeric(14,2) AS revenue
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
