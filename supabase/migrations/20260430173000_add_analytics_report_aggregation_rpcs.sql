-- Push remaining analytics report aggregations to SQL RPCs.

CREATE OR REPLACE FUNCTION public.get_analytics_top_products(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  product_name TEXT,
  units_sold BIGINT,
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
    SELECT DISTINCT o.id
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
  )
  SELECT
    coalesce(
      nullif(
        concat_ws(' - ', nullif(trim(oi.product), ''), nullif(trim(oi.variant), '')),
        ''
      ),
      'Item'
    )::text AS product_name,
    coalesce(sum(coalesce(oi.quantity, 0)), 0)::bigint AS units_sold,
    coalesce(sum(coalesce(oi.quantity, 0) * coalesce(oi.price, 0)), 0)::numeric(14,2) AS revenue
  FROM public.shopify_order_items oi
  INNER JOIN scoped_orders so ON so.id = oi.order_id
  GROUP BY 1
  ORDER BY revenue DESC, product_name ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_top_customers(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  customer_label TEXT,
  customer_email TEXT,
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
      o.customer_id,
      o.shopify_customer_id,
      o.customer_name,
      o.email,
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
  )
  SELECT
    coalesce(
      nullif(max(nullif(btrim(coalesce(so.customer_name, '')), '')), ''),
      nullif(max(nullif(btrim(coalesce(so.email, '')), '')), ''),
      'Guest'
    )::text AS customer_label,
    coalesce(nullif(max(nullif(btrim(coalesce(so.email, '')), '')), ''), '')::text AS customer_email,
    count(*)::bigint AS orders_count,
    coalesce(sum(so.total), 0)::numeric(14,2) AS revenue
  FROM scoped_orders so
  GROUP BY coalesce(
    CASE WHEN so.customer_id IS NOT NULL THEN 'id:' || so.customer_id::text ELSE NULL END,
    CASE WHEN so.shopify_customer_id IS NOT NULL THEN 'sid:' || so.shopify_customer_id::text ELSE NULL END,
    CASE WHEN so.email IS NOT NULL AND btrim(so.email) <> '' THEN 'em:' || lower(trim(so.email)) ELSE NULL END,
    CASE WHEN so.customer_name IS NOT NULL AND btrim(so.customer_name) <> '' THEN 'nm:' || btrim(so.customer_name) ELSE NULL END,
    'guest:no-detail'
  )
  ORDER BY revenue DESC, customer_label ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_payment_status_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  payment_status TEXT,
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
      coalesce(o.financial_status, 'unknown') AS financial_status,
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
  )
  SELECT
    financial_status::text AS payment_status,
    count(*)::bigint AS orders_count,
    coalesce(sum(total), 0)::numeric(14,2) AS revenue
  FROM scoped_orders
  GROUP BY financial_status
  ORDER BY revenue DESC, payment_status ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_fulfillment_status_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  fulfillment_status TEXT,
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
      coalesce(o.fulfillment_status, 'unknown') AS fulfillment_status,
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
  )
  SELECT
    fulfillment_status::text AS fulfillment_status,
    count(*)::bigint AS orders_count,
    coalesce(sum(total), 0)::numeric(14,2) AS revenue
  FROM scoped_orders
  GROUP BY fulfillment_status
  ORDER BY revenue DESC, fulfillment_status ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_tax_summary_rows(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  breakdown TEXT,
  currency_code TEXT,
  subtotal NUMERIC(14,2),
  tax NUMERIC(14,2),
  total NUMERIC(14,2)
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
      coalesce(o.currency_code, 'GBP')::text AS currency_code,
      coalesce(o.subtotal, 0)::numeric AS subtotal,
      coalesce(o.total_tax, 0)::numeric AS total_tax,
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
  ),
  by_currency AS (
    SELECT
      currency_code,
      coalesce(sum(subtotal), 0)::numeric(14,2) AS subtotal,
      coalesce(sum(total_tax), 0)::numeric(14,2) AS tax,
      coalesce(sum(total), 0)::numeric(14,2) AS total
    FROM scoped_orders
    GROUP BY currency_code
  ),
  total_all AS (
    SELECT
      coalesce(sum(subtotal), 0)::numeric(14,2) AS subtotal,
      coalesce(sum(tax), 0)::numeric(14,2) AS tax,
      coalesce(sum(total), 0)::numeric(14,2) AS total
    FROM by_currency
  )
  SELECT x.breakdown, x.currency_code, x.subtotal, x.tax, x.total
  FROM (
    SELECT
      0::int AS sort_rank,
      'All currencies combined'::text AS breakdown,
      '—'::text AS currency_code,
      ta.subtotal,
      ta.tax,
      ta.total
    FROM total_all ta
    UNION ALL
    SELECT
      1::int AS sort_rank,
      ('Currency: ' || bc.currency_code)::text AS breakdown,
      bc.currency_code,
      bc.subtotal,
      bc.tax,
      bc.total
    FROM by_currency bc
  ) x
  ORDER BY x.sort_rank, x.breakdown;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_sales_by_salesperson(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  salesperson_name TEXT,
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
      coalesce(o.total, 0)::numeric AS total,
      coalesce(o.customer_id, sc.customer_id) AS customer_id_resolved
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
  order_attribution AS (
    SELECT
      so.id AS order_id,
      so.total,
      coalesce(att.salesperson_name, 'Unassigned')::text AS salesperson_name
    FROM scoped_orders so
    LEFT JOIN LATERAL (
      SELECT DISTINCT vsca.salesperson_name
      FROM public.v_salesperson_customer_attribution vsca
      WHERE vsca.customer_id = so.customer_id_resolved
    ) att ON true
  )
  SELECT
    oa.salesperson_name,
    count(DISTINCT oa.order_id)::bigint AS orders_count,
    coalesce(sum(oa.total), 0)::numeric(14,2) AS revenue
  FROM order_attribution oa
  GROUP BY oa.salesperson_name
  ORDER BY revenue DESC, oa.salesperson_name ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_analytics_top_products(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_analytics_top_customers(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_analytics_payment_status_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_analytics_fulfillment_status_breakdown(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_analytics_tax_summary_rows(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_analytics_sales_by_salesperson(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated, service_role;
