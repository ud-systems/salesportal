-- Optimize scoped orders and order-items pagination RPCs by removing OR-heavy
-- scope matching predicates and replacing them with candidate order sets.
-- This improves planner/index usage across all role-scoped list pages.

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
  _force_scoped_filter BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  row_data JSONB,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_sort_col TEXT;
  v_sort_dir TEXT;
  v_offset INTEGER;
BEGIN
  IF _viewer_user_id IS NULL THEN
    RAISE EXCEPTION 'viewer user id is required';
  END IF;

  IF auth.uid() IS NULL OR (auth.uid() <> _viewer_user_id AND NOT public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  v_sort_col := CASE coalesce(_sort_by, 'shopify_created_at')
    WHEN 'shopify_created_at' THEN 'shopify_created_at'
    WHEN 'processed_at' THEN 'processed_at'
    WHEN 'total' THEN 'total'
    WHEN 'order_number' THEN 'order_number'
    ELSE 'shopify_created_at'
  END;

  v_sort_dir := CASE lower(coalesce(_sort_dir, 'desc'))
    WHEN 'asc' THEN 'ASC'
    ELSE 'DESC'
  END;

  v_offset := GREATEST(coalesce(_page, 1), 1) - 1;
  v_offset := v_offset * GREATEST(coalesce(_page_size, 15), 1);

  RETURN QUERY EXECUTE format(
    $sql$
      WITH name_scope AS (
        SELECT DISTINCT lower(trim(nm)) AS owner_name
        FROM unnest(coalesce($3, ARRAY[]::text[])) nm
        WHERE coalesce(trim(nm), '') <> ''
      ),
      scoped_customers AS (
        SELECT DISTINCT
          c.id AS customer_id,
          c.shopify_customer_id
        FROM public.shopify_customers c
        WHERE EXISTS (
          SELECT 1
          FROM public.get_scoped_customer_ids_for_salespeople($1, $2) t
          WHERE t.customer_id = c.id
        )
        UNION
        SELECT DISTINCT
          c.id AS customer_id,
          c.shopify_customer_id
        FROM public.shopify_customers c
        INNER JOIN name_scope ns
          ON lower(trim(coalesce(c.sp_assigned, ''))) = ns.owner_name
          OR lower(trim(coalesce(c.referred_by, ''))) = ns.owner_name
      ),
      candidate_orders_direct AS (
        SELECT DISTINCT o.id
        FROM public.shopify_orders o
        INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
      ),
      candidate_orders_fallback AS (
        SELECT DISTINCT o.id
        FROM public.shopify_orders o
        INNER JOIN scoped_customers sc
          ON o.customer_id IS NULL
          AND o.shopify_customer_id IS NOT NULL
          AND sc.shopify_customer_id IS NOT NULL
          AND o.shopify_customer_id = sc.shopify_customer_id
      ),
      candidate_orders AS (
        SELECT id FROM candidate_orders_direct
        UNION
        SELECT id FROM candidate_orders_fallback
      ),
      filtered AS (
        SELECT o.*
        FROM public.shopify_orders o
        WHERE (
          NOT coalesce($12, true)
          OR EXISTS (SELECT 1 FROM candidate_orders co WHERE co.id = o.id)
        )
          AND (
            coalesce(trim($4), '') = ''
            OR coalesce(o.order_number::text, '') ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
            OR coalesce(o.customer_name, '') ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
          )
          AND (
            coalesce($5, 'all') = 'all'
            OR o.financial_status = $5
          )
          AND (
            coalesce($6, 'all') = 'all'
            OR o.fulfillment_status = $6
          )
          AND ($7 IS NULL OR o.shopify_created_at >= $7)
          AND ($8 IS NULL OR o.shopify_created_at <= $8)
      ),
      page_rows AS (
        SELECT
          to_jsonb(f) AS row_data,
          count(*) OVER()::bigint AS total_count
        FROM filtered f
        ORDER BY %I %s NULLS LAST
        OFFSET $9
        LIMIT $10
      )
      SELECT p.row_data, p.total_count
      FROM page_rows p
    $sql$,
    v_sort_col,
    v_sort_dir
  )
  USING
    _viewer_user_id,
    _salesperson_user_ids,
    _owner_names,
    _search,
    _status_filter,
    _fulfillment_filter,
    _from_iso,
    _to_iso,
    v_offset,
    GREATEST(coalesce(_page_size, 15), 1),
    v_sort_col,
    _force_scoped_filter;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_scoped_orders_page(
  UUID, UUID[], TEXT[], TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_scoped_order_items_page(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _owner_names TEXT[] DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _page INTEGER DEFAULT 1,
  _page_size INTEGER DEFAULT 500,
  _force_scoped_filter BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  row_data JSONB,
  total_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_offset INTEGER;
BEGIN
  IF _viewer_user_id IS NULL THEN
    RAISE EXCEPTION 'viewer user id is required';
  END IF;

  IF auth.uid() IS NULL OR (auth.uid() <> _viewer_user_id AND NOT public.has_role(auth.uid(), 'admin')) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  v_offset := GREATEST(coalesce(_page, 1), 1) - 1;
  v_offset := v_offset * GREATEST(coalesce(_page_size, 500), 1);

  RETURN QUERY
  WITH name_scope AS (
    SELECT DISTINCT lower(trim(nm)) AS owner_name
    FROM unnest(coalesce(_owner_names, ARRAY[]::text[])) nm
    WHERE coalesce(trim(nm), '') <> ''
  ),
  scoped_customers AS (
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.shopify_customers c
    WHERE EXISTS (
      SELECT 1
      FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids) t
      WHERE t.customer_id = c.id
    )
    UNION
    SELECT DISTINCT
      c.id AS customer_id,
      c.shopify_customer_id
    FROM public.shopify_customers c
    INNER JOIN name_scope ns
      ON lower(trim(coalesce(c.sp_assigned, ''))) = ns.owner_name
      OR lower(trim(coalesce(c.referred_by, ''))) = ns.owner_name
  ),
  candidate_orders_direct AS (
    SELECT DISTINCT o.id, o.order_number, o.shopify_created_at, o.currency_code
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
  ),
  candidate_orders_fallback AS (
    SELECT DISTINCT o.id, o.order_number, o.shopify_created_at, o.currency_code
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
  ),
  candidate_orders AS (
    SELECT * FROM candidate_orders_direct
    UNION
    SELECT * FROM candidate_orders_fallback
  ),
  scoped_orders AS (
    SELECT
      o.id,
      o.order_number,
      o.shopify_created_at,
      o.currency_code
    FROM public.shopify_orders o
    WHERE (
      NOT coalesce(_force_scoped_filter, true)
      OR EXISTS (SELECT 1 FROM candidate_orders co WHERE co.id = o.id)
    )
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
  ),
  filtered AS (
    SELECT
      so.id AS order_id,
      so.order_number,
      so.shopify_created_at,
      so.currency_code,
      oi.product,
      oi.variant,
      oi.sku,
      oi.quantity,
      oi.price
    FROM scoped_orders so
    INNER JOIN public.shopify_order_items oi ON oi.order_id = so.id
  ),
  page_rows AS (
    SELECT
      to_jsonb(f) AS row_data,
      count(*) OVER()::bigint AS total_count
    FROM filtered f
    ORDER BY f.shopify_created_at DESC NULLS LAST, f.order_id DESC
    OFFSET v_offset
    LIMIT GREATEST(coalesce(_page_size, 500), 1)
  )
  SELECT p.row_data, p.total_count
  FROM page_rows p;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_scoped_order_items_page(
  UUID, UUID[], TEXT[], TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, INTEGER, BOOLEAN
) TO authenticated, service_role;
