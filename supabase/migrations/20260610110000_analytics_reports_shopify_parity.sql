-- Analytics reports: reporting-day period filter + Shopify analytics revenue (dashboard parity).
-- Requires 20260610100000_shopify_analytics_epoch_parity.sql.

CREATE OR REPLACE FUNCTION public.shopify_order_analytics_total_sales(_order_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH o AS (
    SELECT *
    FROM public.shopify_orders
    WHERE id = _order_id
    LIMIT 1
  ),
  line AS (
    SELECT
      public.normalize_financial_status(o.financial_status) AS st,
      coalesce(
        f.total_sales,
        (
          coalesce(
            f.gross_sales,
            public.shopify_order_analytics_gross(o.subtotal, o.reporting_line_items_gross)
          )
          - coalesce(
            f.discounts,
            public.shopify_order_analytics_discount(
              o.id,
              o.subtotal,
              o.reporting_original_total_discounts,
              o.reporting_total_discounts,
              o.reporting_line_items_gross
            )
          )
          + coalesce(o.reporting_total_shipping, 0)
          + round(
            (
              coalesce(
                f.gross_sales,
                public.shopify_order_analytics_gross(o.subtotal, o.reporting_line_items_gross)
              )
              - coalesce(
                f.discounts,
                public.shopify_order_analytics_discount(
                  o.id,
                  o.subtotal,
                  o.reporting_original_total_discounts,
                  o.reporting_total_discounts,
                  o.reporting_line_items_gross
                )
              )
            ) * public.shopify_analytics_vat_rate(),
            2
          )
        )
      ) AS amt
    FROM o
    LEFT JOIN public.shopify_analytics_order_facts f
      ON f.shopify_order_id = o.shopify_order_id
     AND f.reporting_day = public.shopify_reporting_day_bucket(o.shopify_created_at)::date
  )
  SELECT CASE WHEN line.st = 'voided' THEN 0::numeric ELSE round(coalesce(line.amt, 0)::numeric, 2) END
  FROM line;
$$;

GRANT EXECUTE ON FUNCTION public.shopify_order_analytics_total_sales(uuid) TO authenticated, service_role;

-- Team performance: Shopify breakdown revenue + financial counts.
CREATE OR REPLACE FUNCTION public.get_analytics_scope_performance_rows(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _role_filter TEXT DEFAULT 'all'
)
RETURNS TABLE (
  viewer_user_id UUID,
  viewer_name TEXT,
  viewer_role public.app_role,
  team_member_count BIGINT,
  team_customers_count BIGINT,
  team_orders_count BIGINT,
  team_revenue NUMERIC(14,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  WITH authz AS (
    SELECT
      public.has_role(auth.uid(), 'admin') AS is_admin,
      (auth.uid() = _viewer_user_id) AS is_self
  ),
  allowed_viewers AS (
    SELECT v.viewer_user_id
    FROM public.v_user_scope_performance v
    CROSS JOIN authz a
    WHERE a.is_admin
    UNION
    SELECT DISTINCT unnest(
      coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])
    ) AS viewer_user_id
    FROM authz a
    WHERE NOT a.is_admin AND a.is_self
    UNION
    SELECT _viewer_user_id
    FROM authz a
    WHERE NOT a.is_admin AND a.is_self
  ),
  role_names AS (
    SELECT
      ur.user_id,
      max(NULLIF(btrim(ur.salesperson_name), '')) AS role_display_name
    FROM public.user_roles ur
    GROUP BY ur.user_id
  ),
  base AS (
    SELECT
      v.viewer_user_id,
      v.viewer_role,
      v.team_member_count
    FROM public.v_user_scope_performance v
    INNER JOIN allowed_viewers av ON av.viewer_user_id = v.viewer_user_id
    WHERE (
      lower(coalesce(_role_filter, 'all')) = 'all'
      OR (lower(_role_filter) = 'manager' AND v.viewer_role = 'manager')
      OR (lower(_role_filter) = 'supervisor' AND v.viewer_role = 'supervisor')
    )
  )
  SELECT
    b.viewer_user_id,
    coalesce(rn.role_display_name, b.viewer_user_id::text)::text AS viewer_name,
    b.viewer_role,
    b.team_member_count,
    coalesce(fin.customers_count, 0)::bigint AS team_customers_count,
    coalesce(shop.orders_in_scope, 0)::bigint AS team_orders_count,
    coalesce(shop.total_sales_check, 0)::numeric(14,2) AS team_revenue
  FROM base b
  LEFT JOIN role_names rn ON rn.user_id = b.viewer_user_id
  LEFT JOIN LATERAL (
    SELECT bd.orders_in_scope, bd.total_sales_check
    FROM public.get_scope_shopify_sales_breakdown(b.viewer_user_id, _from_iso, _to_iso) bd
  ) shop ON true
  LEFT JOIN LATERAL (
    SELECT fin.customers_count
    FROM public.get_scope_financial_breakdown(b.viewer_user_id, _from_iso, _to_iso) fin
  ) fin ON true
  ORDER BY team_revenue DESC, viewer_name ASC;
$$;

-- Shared period predicate for analytics report aggregations (sales event day, Dubai).
CREATE OR REPLACE FUNCTION public.shopify_analytics_order_in_reporting_period(
  _order_ts timestamptz,
  _from_iso timestamptz,
  _to_iso timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT public.shopify_order_reporting_day_in_period(_order_ts, _from_iso, _to_iso);
$$;

GRANT EXECUTE ON FUNCTION public.shopify_analytics_order_in_reporting_period(timestamptz, timestamptz, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_analytics_top_products(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (product_name TEXT, units_sold BIGINT, revenue NUMERIC(14,2))
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH viewer_flags AS (SELECT public.has_role(auth.uid(), 'admin') AS is_admin),
  scope_users AS (
    SELECT unnest(coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])) AS user_id
  ),
  scope_names AS (
    SELECT DISTINCT lower(trim(ur.salesperson_name)) AS salesperson_name_norm
    FROM public.user_roles ur INNER JOIN scope_users su ON su.user_id = ur.user_id
    WHERE ur.salesperson_name IS NOT NULL AND btrim(ur.salesperson_name) <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id, c.shopify_customer_id FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf WHERE NOT vf.is_admin AND (
      EXISTS (SELECT 1 FROM public.salesperson_customer_assignments a
        INNER JOIN scope_users su ON su.user_id = a.salesperson_user_id WHERE a.customer_id = c.id)
      OR EXISTS (SELECT 1 FROM scope_names sn
        WHERE sn.salesperson_name_norm = lower(trim(coalesce(c.sp_assigned, '')))
           OR sn.salesperson_name_norm = lower(trim(coalesce(c.referred_by, ''))))
    )
  ),
  scoped_orders AS (
    SELECT DISTINCT o.id FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
      OR (o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
          AND sc.shopify_customer_id IS NOT NULL AND o.shopify_customer_id = sc.shopify_customer_id)
    WHERE public.shopify_analytics_order_in_reporting_period(o.shopify_created_at, _from_iso, _to_iso)
      AND coalesce(o.test_order, false) = false
  )
  SELECT coalesce(nullif(concat_ws(' - ', nullif(trim(oi.product), ''), nullif(trim(oi.variant), '')), ''), 'Item')::text,
    coalesce(sum(coalesce(oi.quantity, 0)), 0)::bigint,
    coalesce(sum(coalesce(oi.quantity, 0) * coalesce(oi.price, 0)), 0)::numeric(14,2)
  FROM public.shopify_order_items oi
  INNER JOIN scoped_orders so ON so.id = oi.order_id
  GROUP BY 1 ORDER BY 3 DESC, 1 ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_top_customers(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (customer_label TEXT, customer_email TEXT, orders_count BIGINT, revenue NUMERIC(14,2))
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH viewer_flags AS (SELECT public.has_role(auth.uid(), 'admin') AS is_admin),
  scope_users AS (
    SELECT unnest(coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])) AS user_id
  ),
  scope_names AS (
    SELECT DISTINCT lower(trim(ur.salesperson_name)) AS salesperson_name_norm
    FROM public.user_roles ur INNER JOIN scope_users su ON su.user_id = ur.user_id
    WHERE ur.salesperson_name IS NOT NULL AND btrim(ur.salesperson_name) <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id, c.shopify_customer_id FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf WHERE NOT vf.is_admin AND (
      EXISTS (SELECT 1 FROM public.salesperson_customer_assignments a
        INNER JOIN scope_users su ON su.user_id = a.salesperson_user_id WHERE a.customer_id = c.id)
      OR EXISTS (SELECT 1 FROM scope_names sn
        WHERE sn.salesperson_name_norm = lower(trim(coalesce(c.sp_assigned, '')))
           OR sn.salesperson_name_norm = lower(trim(coalesce(c.referred_by, ''))))
    )
  ),
  scoped_orders AS (
    SELECT DISTINCT o.id, o.customer_id, o.shopify_customer_id, o.customer_name, o.email
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
      OR (o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
          AND sc.shopify_customer_id IS NOT NULL AND o.shopify_customer_id = sc.shopify_customer_id)
    WHERE public.shopify_analytics_order_in_reporting_period(o.shopify_created_at, _from_iso, _to_iso)
      AND coalesce(o.test_order, false) = false
  )
  SELECT
    coalesce(nullif(max(nullif(btrim(coalesce(so.customer_name, '')), '')), ''),
      nullif(max(nullif(btrim(coalesce(so.email, '')), '')), ''), 'Guest')::text,
    coalesce(nullif(max(nullif(btrim(coalesce(so.email, '')), '')), ''), '')::text,
    count(*)::bigint,
    coalesce(sum(public.shopify_order_analytics_total_sales(so.id)), 0)::numeric(14,2)
  FROM scoped_orders so
  GROUP BY coalesce(
    CASE WHEN so.customer_id IS NOT NULL THEN 'id:' || so.customer_id::text END,
    CASE WHEN so.shopify_customer_id IS NOT NULL THEN 'sid:' || so.shopify_customer_id::text END,
    CASE WHEN so.email IS NOT NULL AND btrim(so.email) <> '' THEN 'em:' || lower(trim(so.email)) END,
    CASE WHEN so.customer_name IS NOT NULL AND btrim(so.customer_name) <> '' THEN 'nm:' || btrim(so.customer_name) END,
    'guest:no-detail')
  ORDER BY 4 DESC, 1 ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_payment_status_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (payment_status TEXT, orders_count BIGINT, revenue NUMERIC(14,2))
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH viewer_flags AS (SELECT public.has_role(auth.uid(), 'admin') AS is_admin),
  scope_users AS (
    SELECT unnest(coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])) AS user_id
  ),
  scope_names AS (
    SELECT DISTINCT lower(trim(ur.salesperson_name)) AS salesperson_name_norm
    FROM public.user_roles ur INNER JOIN scope_users su ON su.user_id = ur.user_id
    WHERE ur.salesperson_name IS NOT NULL AND btrim(ur.salesperson_name) <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id, c.shopify_customer_id FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf WHERE NOT vf.is_admin AND (
      EXISTS (SELECT 1 FROM public.salesperson_customer_assignments a
        INNER JOIN scope_users su ON su.user_id = a.salesperson_user_id WHERE a.customer_id = c.id)
      OR EXISTS (SELECT 1 FROM scope_names sn
        WHERE sn.salesperson_name_norm = lower(trim(coalesce(c.sp_assigned, '')))
           OR sn.salesperson_name_norm = lower(trim(coalesce(c.referred_by, ''))))
    )
  ),
  scoped_orders AS (
    SELECT DISTINCT o.id, coalesce(o.financial_status, 'unknown') AS financial_status
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
      OR (o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
          AND sc.shopify_customer_id IS NOT NULL AND o.shopify_customer_id = sc.shopify_customer_id)
    WHERE public.shopify_analytics_order_in_reporting_period(o.shopify_created_at, _from_iso, _to_iso)
      AND coalesce(o.test_order, false) = false
  )
  SELECT financial_status::text, count(*)::bigint,
    coalesce(sum(public.shopify_order_analytics_total_sales(so.id)), 0)::numeric(14,2)
  FROM scoped_orders so GROUP BY financial_status ORDER BY 3 DESC, 1 ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_fulfillment_status_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (fulfillment_status TEXT, orders_count BIGINT, revenue NUMERIC(14,2))
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH viewer_flags AS (SELECT public.has_role(auth.uid(), 'admin') AS is_admin),
  scope_users AS (
    SELECT unnest(coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])) AS user_id
  ),
  scope_names AS (
    SELECT DISTINCT lower(trim(ur.salesperson_name)) AS salesperson_name_norm
    FROM public.user_roles ur INNER JOIN scope_users su ON su.user_id = ur.user_id
    WHERE ur.salesperson_name IS NOT NULL AND btrim(ur.salesperson_name) <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id, c.shopify_customer_id FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf WHERE NOT vf.is_admin AND (
      EXISTS (SELECT 1 FROM public.salesperson_customer_assignments a
        INNER JOIN scope_users su ON su.user_id = a.salesperson_user_id WHERE a.customer_id = c.id)
      OR EXISTS (SELECT 1 FROM scope_names sn
        WHERE sn.salesperson_name_norm = lower(trim(coalesce(c.sp_assigned, '')))
           OR sn.salesperson_name_norm = lower(trim(coalesce(c.referred_by, ''))))
    )
  ),
  scoped_orders AS (
    SELECT DISTINCT o.id, coalesce(o.fulfillment_status, 'unknown') AS fulfillment_status
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
      OR (o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
          AND sc.shopify_customer_id IS NOT NULL AND o.shopify_customer_id = sc.shopify_customer_id)
    WHERE public.shopify_analytics_order_in_reporting_period(o.shopify_created_at, _from_iso, _to_iso)
      AND coalesce(o.test_order, false) = false
  )
  SELECT fulfillment_status::text, count(*)::bigint,
    coalesce(sum(public.shopify_order_analytics_total_sales(so.id)), 0)::numeric(14,2)
  FROM scoped_orders so GROUP BY fulfillment_status ORDER BY 3 DESC, 1 ASC;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_sales_by_salesperson(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (salesperson_name TEXT, orders_count BIGINT, revenue NUMERIC(14,2))
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH viewer_flags AS (SELECT public.has_role(auth.uid(), 'admin') AS is_admin),
  scope_users AS (
    SELECT unnest(coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])) AS user_id
  ),
  scope_names AS (
    SELECT DISTINCT lower(trim(ur.salesperson_name)) AS salesperson_name_norm
    FROM public.user_roles ur INNER JOIN scope_users su ON su.user_id = ur.user_id
    WHERE ur.salesperson_name IS NOT NULL AND btrim(ur.salesperson_name) <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.id, c.shopify_customer_id FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf WHERE NOT vf.is_admin AND (
      EXISTS (SELECT 1 FROM public.salesperson_customer_assignments a
        INNER JOIN scope_users su ON su.user_id = a.salesperson_user_id WHERE a.customer_id = c.id)
      OR EXISTS (SELECT 1 FROM scope_names sn
        WHERE sn.salesperson_name_norm = lower(trim(coalesce(c.sp_assigned, '')))
           OR sn.salesperson_name_norm = lower(trim(coalesce(c.referred_by, ''))))
    )
  ),
  scoped_orders AS (
    SELECT DISTINCT o.id, coalesce(o.customer_id, sc.customer_id) AS customer_id_resolved
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
      OR (o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
          AND sc.shopify_customer_id IS NOT NULL AND o.shopify_customer_id = sc.shopify_customer_id)
    WHERE public.shopify_analytics_order_in_reporting_period(o.shopify_created_at, _from_iso, _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  order_attribution AS (
    SELECT so.id AS order_id,
      coalesce(att.salesperson_name, 'Unassigned')::text AS salesperson_name
    FROM scoped_orders so
    LEFT JOIN LATERAL (
      SELECT DISTINCT vsca.salesperson_name FROM public.v_salesperson_customer_attribution vsca
      WHERE vsca.customer_id = so.customer_id_resolved
    ) att ON true
  )
  SELECT oa.salesperson_name, count(DISTINCT oa.order_id)::bigint,
    coalesce(sum(public.shopify_order_analytics_total_sales(oa.order_id)), 0)::numeric(14,2)
  FROM order_attribution oa GROUP BY oa.salesperson_name ORDER BY 3 DESC, 1 ASC;
$$;

-- Scoped list RPCs: optional reporting-day period filter (reports); default created-at (Orders page).
DROP FUNCTION IF EXISTS public.get_scoped_order_items_page(
  uuid, uuid[], text[], timestamptz, timestamptz, integer, integer, boolean
);

CREATE OR REPLACE FUNCTION public.get_scoped_order_items_page(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _owner_names TEXT[] DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _page INTEGER DEFAULT 1,
  _page_size INTEGER DEFAULT 500,
  _force_scoped_filter BOOLEAN DEFAULT TRUE,
  _filter_by_reporting_day BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (row_data JSONB, total_count BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE v_offset INTEGER;
BEGIN
  IF _viewer_user_id IS NULL THEN RAISE EXCEPTION 'viewer user id is required'; END IF;
  IF auth.uid() IS NULL OR (auth.uid() <> _viewer_user_id AND NOT public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  v_offset := (GREATEST(coalesce(_page, 1), 1) - 1) * GREATEST(coalesce(_page_size, 500), 1);
  RETURN QUERY
  WITH name_scope AS (
    SELECT DISTINCT lower(trim(nm)) AS owner_name FROM unnest(coalesce(_owner_names, ARRAY[]::text[])) nm
    WHERE coalesce(trim(nm), '') <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id FROM public.shopify_customers c
    WHERE EXISTS (SELECT 1 FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids) t WHERE t.customer_id = c.id)
    UNION
    SELECT DISTINCT c.id, c.shopify_customer_id FROM public.shopify_customers c
    INNER JOIN name_scope ns ON lower(trim(coalesce(c.sp_assigned, ''))) = ns.owner_name
      OR lower(trim(coalesce(c.referred_by, ''))) = ns.owner_name
  ),
  candidate_orders AS (
    SELECT DISTINCT o.id, o.order_number, o.shopify_created_at, o.currency_code
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
      OR (o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
          AND sc.shopify_customer_id IS NOT NULL AND o.shopify_customer_id = sc.shopify_customer_id)
  ),
  scoped_orders AS (
    SELECT o.id, o.order_number, o.shopify_created_at, o.currency_code
    FROM public.shopify_orders o
    WHERE (NOT coalesce(_force_scoped_filter, true) OR EXISTS (SELECT 1 FROM candidate_orders co WHERE co.id = o.id))
      AND (
        CASE WHEN coalesce(_filter_by_reporting_day, false) THEN
          public.shopify_order_reporting_day_in_period(o.shopify_created_at, _from_iso, _to_iso)
        ELSE
          (_from_iso IS NULL OR o.shopify_created_at >= _from_iso) AND (_to_iso IS NULL OR o.shopify_created_at < _to_iso)
        END
      )
  ),
  filtered AS (
    SELECT so.id AS order_id, so.order_number, so.shopify_created_at, so.currency_code,
      oi.product, oi.variant, oi.sku, oi.quantity, oi.price
    FROM scoped_orders so
    INNER JOIN public.shopify_order_items oi ON oi.order_id = so.id
  ),
  page_rows AS (
    SELECT to_jsonb(f) AS row_data, count(*) OVER()::bigint AS total_count
    FROM filtered f
    ORDER BY f.shopify_created_at DESC NULLS LAST, f.order_id DESC
    OFFSET v_offset LIMIT GREATEST(coalesce(_page_size, 500), 1)
  )
  SELECT p.row_data, p.total_count FROM page_rows p;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_scoped_order_items_page(
  uuid, uuid[], text[], timestamptz, timestamptz, integer, integer, boolean, boolean
) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.get_scoped_orders_page(
  uuid, uuid[], text[], text, text, text, timestamptz, timestamptz, text, text, integer, integer, boolean, uuid[]
);

CREATE OR REPLACE FUNCTION public.get_scoped_orders_page(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _owner_names TEXT[] DEFAULT NULL,
  _search TEXT DEFAULT NULL,
  _status_filter TEXT DEFAULT 'all',
  _fulfillment_filter TEXT DEFAULT 'all',
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _sort_by TEXT DEFAULT 'shopify_created_at',
  _sort_dir TEXT DEFAULT 'desc',
  _page INTEGER DEFAULT 1,
  _page_size INTEGER DEFAULT 15,
  _force_scoped_filter BOOLEAN DEFAULT TRUE,
  _customer_ids UUID[] DEFAULT NULL,
  _filter_by_reporting_day BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (row_data JSONB, total_count BIGINT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE v_sort_col TEXT; v_sort_dir TEXT; v_offset INTEGER;
BEGIN
  IF _viewer_user_id IS NULL THEN RAISE EXCEPTION 'viewer user id is required'; END IF;
  IF auth.uid() IS NULL OR (auth.uid() <> _viewer_user_id AND NOT public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  v_sort_col := CASE coalesce(_sort_by, 'shopify_created_at')
    WHEN 'processed_at' THEN 'processed_at' WHEN 'total' THEN 'total'
    WHEN 'order_number' THEN 'order_number' ELSE 'shopify_created_at' END;
  v_sort_dir := CASE lower(coalesce(_sort_dir, 'desc')) WHEN 'asc' THEN 'ASC' ELSE 'DESC' END;
  v_offset := (GREATEST(coalesce(_page, 1), 1) - 1) * GREATEST(coalesce(_page_size, 15), 1);
  RETURN QUERY EXECUTE format($sql$
      WITH name_scope AS (
        SELECT DISTINCT lower(trim(nm)) AS owner_name FROM unnest(coalesce($3, ARRAY[]::text[])) nm
        WHERE coalesce(trim(nm), '') <> ''
      ),
      explicit_scope AS (
        SELECT c.id AS customer_id, c.shopify_customer_id FROM public.shopify_customers c
        WHERE c.id = ANY(coalesce($12, ARRAY[]::uuid[]))
      ),
      scoped_customers AS (
        SELECT DISTINCT c.id AS customer_id, c.shopify_customer_id FROM public.shopify_customers c
        WHERE EXISTS (SELECT 1 FROM public.get_scoped_customer_ids_for_salespeople($1, $2) t WHERE t.customer_id = c.id)
        UNION
        SELECT DISTINCT c.id, c.shopify_customer_id FROM public.shopify_customers c
        INNER JOIN name_scope ns ON lower(trim(coalesce(c.sp_assigned, ''))) = ns.owner_name
          OR lower(trim(coalesce(c.referred_by, ''))) = ns.owner_name
        UNION SELECT es.customer_id, es.shopify_customer_id FROM explicit_scope es
      ),
      candidate_orders AS (
        SELECT DISTINCT o.id FROM public.shopify_orders o INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
        UNION
        SELECT DISTINCT o.id FROM public.shopify_orders o INNER JOIN scoped_customers sc
          ON o.customer_id IS NULL AND o.shopify_customer_id IS NOT NULL
         AND sc.shopify_customer_id IS NOT NULL AND o.shopify_customer_id = sc.shopify_customer_id
      ),
      filtered AS (
        SELECT o.* FROM public.shopify_orders o
        WHERE (NOT coalesce($11, true) OR EXISTS (SELECT 1 FROM candidate_orders co WHERE co.id = o.id))
          AND (coalesce(trim($4), '') = '' OR coalesce(o.order_number::text, '') ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
            OR coalesce(o.customer_name, '') ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%'))
          AND (coalesce($5, 'all') = 'all' OR o.financial_status = $5)
          AND (coalesce($6, 'all') = 'all' OR o.fulfillment_status = $6)
          AND (
            CASE WHEN coalesce($13, false) THEN
              public.shopify_order_reporting_day_in_period(o.shopify_created_at, $7, $8)
            ELSE
              ($7 IS NULL OR o.shopify_created_at >= $7) AND ($8 IS NULL OR o.shopify_created_at < $8)
            END
          )
      ),
      page_rows AS (
        SELECT to_jsonb(f) AS row_data, count(*) OVER()::bigint AS total_count
        FROM filtered f ORDER BY %I %s NULLS LAST OFFSET $9 LIMIT $10
      )
      SELECT p.row_data, p.total_count FROM page_rows p
    $sql$, v_sort_col, v_sort_dir)
  USING _viewer_user_id, _salesperson_user_ids, _owner_names, _search, _status_filter, _fulfillment_filter,
    _from_iso, _to_iso, v_offset, GREATEST(coalesce(_page_size, 15), 1), _force_scoped_filter, _customer_ids,
    _filter_by_reporting_day;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_scoped_orders_page(
  uuid, uuid[], text[], text, text, text, timestamptz, timestamptz, text, text, integer, integer, boolean, uuid[], boolean
) TO authenticated, service_role;
