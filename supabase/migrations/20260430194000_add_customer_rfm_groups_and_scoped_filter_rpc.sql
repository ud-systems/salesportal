-- Add persistent RFM metrics/grouping for customers and expose filter support
-- in the scoped customers page RPC.

ALTER TABLE public.shopify_customers
  ADD COLUMN IF NOT EXISTS rfm_recency_days INTEGER,
  ADD COLUMN IF NOT EXISTS rfm_frequency INTEGER,
  ADD COLUMN IF NOT EXISTS rfm_monetary NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS rfm_score TEXT,
  ADD COLUMN IF NOT EXISTS rfm_group TEXT;

CREATE INDEX IF NOT EXISTS idx_shopify_customers_rfm_group
  ON public.shopify_customers (rfm_group);

CREATE INDEX IF NOT EXISTS idx_shopify_customers_rfm_score
  ON public.shopify_customers (rfm_score);

CREATE OR REPLACE FUNCTION public.refresh_customer_rfm_metrics(
  _customer_ids UUID[] DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated_count INTEGER := 0;
BEGIN
  WITH target_customers AS (
    SELECT c.id, c.shopify_customer_id
    FROM public.shopify_customers c
    WHERE _customer_ids IS NULL
       OR c.id = ANY(_customer_ids)
  ),
  resolved_orders AS (
    SELECT DISTINCT
      o.id AS order_id,
      tc.id AS customer_id,
      coalesce(o.total, 0)::numeric(14,2) AS order_total,
      COALESCE(o.processed_at, o.shopify_created_at, o.created_at) AS order_ts
    FROM public.shopify_orders o
    INNER JOIN target_customers tc
      ON o.customer_id = tc.id
      OR (
        o.customer_id IS NULL
        AND o.shopify_customer_id IS NOT NULL
        AND tc.shopify_customer_id IS NOT NULL
        AND o.shopify_customer_id = tc.shopify_customer_id
      )
    WHERE coalesce(o.test_order, false) = false
  ),
  agg AS (
    SELECT
      tc.id AS customer_id,
      CASE
        WHEN max(ro.order_ts) IS NULL THEN 9999
        ELSE GREATEST(0, floor(extract(epoch FROM (now() - max(ro.order_ts))) / 86400)::int)
      END AS recency_days,
      count(DISTINCT ro.order_id)::int AS frequency_orders,
      coalesce(sum(ro.order_total), 0)::numeric(14,2) AS monetary_total
    FROM target_customers tc
    LEFT JOIN resolved_orders ro ON ro.customer_id = tc.id
    GROUP BY tc.id
  ),
  scored_raw AS (
    SELECT
      a.customer_id,
      a.recency_days,
      a.frequency_orders,
      a.monetary_total,
      CASE
        WHEN a.frequency_orders = 0 THEN 1
        ELSE 6 - ntile(5) OVER (ORDER BY a.recency_days ASC, a.customer_id)
      END AS r_score,
      CASE
        WHEN a.frequency_orders = 0 THEN 1
        ELSE ntile(5) OVER (ORDER BY a.frequency_orders ASC, a.customer_id)
      END AS f_score,
      CASE
        WHEN a.frequency_orders = 0 OR a.monetary_total <= 0 THEN 1
        ELSE ntile(5) OVER (ORDER BY a.monetary_total ASC, a.customer_id)
      END AS m_score
    FROM agg a
  ),
  scored AS (
    SELECT
      sr.customer_id,
      sr.recency_days,
      sr.frequency_orders,
      sr.monetary_total,
      concat(sr.r_score::text, sr.f_score::text, sr.m_score::text) AS score_3d,
      CASE
        WHEN sr.r_score >= 5 AND sr.f_score >= 4 AND sr.m_score >= 4 THEN 'Champions'
        WHEN sr.r_score >= 4 AND sr.f_score >= 4 THEN 'Loyal Customers'
        WHEN sr.r_score >= 4 AND sr.f_score BETWEEN 2 AND 3 THEN 'Potential Loyalists'
        WHEN sr.r_score >= 4 AND sr.f_score <= 1 THEN 'New Customers'
        WHEN sr.r_score = 3 AND sr.f_score >= 3 THEN 'Promising'
        WHEN sr.r_score = 3 AND sr.f_score <= 2 THEN 'Need Attention'
        WHEN sr.r_score = 2 AND sr.f_score >= 3 THEN 'About To Sleep'
        WHEN sr.r_score <= 2 AND sr.f_score >= 4 AND sr.m_score >= 3 THEN 'Can Not Lose Them'
        WHEN sr.r_score <= 2 AND sr.f_score >= 3 THEN 'At Risk'
        WHEN sr.r_score <= 2 AND sr.f_score = 2 THEN 'Hibernating'
        ELSE 'Lost'
      END AS rfm_group
    FROM scored_raw sr
  )
  UPDATE public.shopify_customers c
  SET
    rfm_recency_days = s.recency_days,
    rfm_frequency = s.frequency_orders,
    rfm_monetary = s.monetary_total,
    rfm_score = s.score_3d,
    rfm_group = s.rfm_group
  FROM scored s
  WHERE s.customer_id = c.id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_customer_rfm_metrics(UUID[])
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_scoped_customers_page(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _owner_names TEXT[] DEFAULT NULL,
  _search TEXT DEFAULT NULL,
  _city_filter TEXT DEFAULT 'all',
  _assignment_filter TEXT DEFAULT 'all',
  _rfm_group_filter TEXT DEFAULT 'all',
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL,
  _sort_by TEXT DEFAULT 'total_revenue',
  _sort_dir TEXT DEFAULT 'desc',
  _page INTEGER DEFAULT 1,
  _page_size INTEGER DEFAULT 15,
  _force_scoped_filter BOOLEAN DEFAULT TRUE,
  _customer_ids UUID[] DEFAULT NULL
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

  v_sort_col := CASE coalesce(_sort_by, 'total_revenue')
    WHEN 'total_revenue' THEN 'total_revenue'
    WHEN 'total_orders' THEN 'total_orders'
    WHEN 'shopify_created_at' THEN 'shopify_created_at'
    WHEN 'name' THEN 'name'
    ELSE 'total_revenue'
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
      explicit_scope AS (
        SELECT DISTINCT unnest(coalesce($14, ARRAY[]::uuid[])) AS customer_id
      ),
      scoped_customers AS (
        SELECT DISTINCT t.customer_id
        FROM public.get_scoped_customer_ids_for_salespeople($1, $2) t
        UNION
        SELECT DISTINCT c.id AS customer_id
        FROM public.shopify_customers c
        INNER JOIN name_scope ns
          ON lower(trim(coalesce(c.sp_assigned, ''))) = ns.owner_name
          OR lower(trim(coalesce(c.referred_by, ''))) = ns.owner_name
        UNION
        SELECT DISTINCT es.customer_id
        FROM explicit_scope es
      ),
      filtered AS (
        SELECT c.*
        FROM public.shopify_customers c
        WHERE (
          NOT coalesce($13, true)
          OR EXISTS (SELECT 1 FROM scoped_customers sc WHERE sc.customer_id = c.id)
        )
          AND (
            coalesce(trim($4), '') = ''
            OR c.name ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
            OR c.city ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
            OR c.email ILIKE ('%%' || replace(replace(trim($4), '%%', ''), '_', '') || '%%')
          )
          AND (
            coalesce($5, 'all') = 'all'
            OR c.city = $5
          )
          AND (
            $6 = 'all'
            OR ($6 = 'assigned' AND c.sp_assigned IS NOT NULL AND c.sp_assigned <> 'Unassigned')
            OR ($6 = 'unassigned' AND (c.sp_assigned IS NULL OR c.sp_assigned = 'Unassigned'))
          )
          AND (
            coalesce($7, 'all') = 'all'
            OR coalesce(c.rfm_group, 'Lost') = $7
          )
          AND ($8 IS NULL OR c.shopify_created_at >= $8)
          AND ($9 IS NULL OR c.shopify_created_at <= $9)
      ),
      page_rows AS (
        SELECT
          to_jsonb(f) AS row_data,
          count(*) OVER()::bigint AS total_count
        FROM filtered f
        ORDER BY %I %s
        OFFSET $10
        LIMIT $11
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
    _city_filter,
    _assignment_filter,
    _rfm_group_filter,
    _from_iso,
    _to_iso,
    v_offset,
    GREATEST(coalesce(_page_size, 15), 1),
    v_sort_col,
    _force_scoped_filter,
    _customer_ids;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_scoped_customers_page(
  UUID, UUID[], TEXT[], TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN, UUID[]
) TO authenticated, service_role;

SELECT public.refresh_customer_rfm_metrics(NULL);
