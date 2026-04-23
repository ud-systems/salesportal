-- Paged scoped order-items RPC for analytics reports (manager/supervisor safe).
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
  scoped_orders AS (
    SELECT DISTINCT
      o.id,
      o.order_number,
      o.shopify_created_at,
      o.currency_code
    FROM public.shopify_orders o
    WHERE (
      NOT coalesce(_force_scoped_filter, true)
      OR EXISTS (
        SELECT 1
        FROM scoped_customers sc
        WHERE o.customer_id = sc.customer_id
           OR (
             o.customer_id IS NULL
             AND o.shopify_customer_id IS NOT NULL
             AND sc.shopify_customer_id IS NOT NULL
             AND o.shopify_customer_id = sc.shopify_customer_id
           )
      )
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
