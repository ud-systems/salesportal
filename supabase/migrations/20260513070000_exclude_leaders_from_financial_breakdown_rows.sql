-- Apply the same "exclude leaders from salesperson listings" filter to
-- get_salesperson_financial_breakdown_rows that we already apply to
-- get_salesperson_performance_rows (see 20260512080000).
--
-- Reason: admin-users.buildRoleRows assigns BOTH a 'salesperson' user_roles
-- row AND the leader role (manager/supervisor) whenever a leader is created
-- or updated. Without filtering, leaders re-appear in the financial
-- breakdown variant used by AdminDashboardPage, SalespersonsPage and the
-- Manager Dashboard "Direct Reports Performance" table (which switches to
-- this RPC so that we can render both Gross and Net columns).

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
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur_leader
        WHERE ur_leader.user_id = ur.user_id
          AND ur_leader.role IN ('manager', 'supervisor', 'admin', 'owner')
      )
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
      OR (
        public.has_role(auth.uid(), 'supervisor')
        AND COALESCE(_leader_role, '') = 'manager'
        AND _leader_user_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.sales_hierarchy_edges e_sup
          WHERE e_sup.leader_user_id = auth.uid()
            AND e_sup.leader_role::text = 'supervisor'
            AND e_sup.member_user_id = _leader_user_id
        )
        AND sb.salesperson_user_id IN (
          SELECT e_m.member_user_id
          FROM public.sales_hierarchy_edges e_m
          WHERE e_m.leader_user_id = _leader_user_id
            AND e_m.leader_role::text = 'manager'
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
