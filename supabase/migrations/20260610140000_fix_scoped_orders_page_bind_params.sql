-- Fix get_scoped_orders_page dynamic SQL bind positions.
-- 20260610110000 added _filter_by_reporting_day but kept $12/$13/$14 placeholders from the
-- prior 14-arg version that had an extra unused v_sort_col at $11 in USING. With only 13
-- USING args, $14 was missing and PostgREST returned 400 for every Orders page call.
--
-- Orders page workflow: _filter_by_reporting_day = false (shopify_created_at bounds).
-- Analytics reports: _filter_by_reporting_day = true (reporting-day bounds).

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
