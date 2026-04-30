-- Add Shopify-style RFM matrix support:
-- X axis: Recency score (1..5)
-- Y axis: Frequency + Monetary value score (1..5), approximated via rounded average of F and M scores.

ALTER TABLE public.shopify_customers
  ADD COLUMN IF NOT EXISTS rfm_recency_score SMALLINT,
  ADD COLUMN IF NOT EXISTS rfm_frequency_score SMALLINT,
  ADD COLUMN IF NOT EXISTS rfm_monetary_score SMALLINT;

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
      sr.r_score,
      sr.f_score,
      sr.m_score,
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
    rfm_group = s.rfm_group,
    rfm_recency_score = s.r_score,
    rfm_frequency_score = s.f_score,
    rfm_monetary_score = s.m_score
  FROM scored s
  WHERE s.customer_id = c.id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_analytics_rfm_score_matrix(
  _viewer_user_id UUID
)
RETURNS TABLE (
  recency_score SMALLINT,
  fm_score SMALLINT,
  customers_count BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
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
    SELECT DISTINCT c.*
    FROM public.shopify_customers c
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
    UNION
    SELECT DISTINCT c.*
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
  matrix_rows AS (
    SELECT
      coalesce(sc.rfm_recency_score, 1)::smallint AS recency_score,
      GREATEST(
        1,
        LEAST(
          5,
          round((coalesce(sc.rfm_frequency_score, 1) + coalesce(sc.rfm_monetary_score, 1)) / 2.0)::int
        )
      )::smallint AS fm_score
    FROM scoped_customers sc
  )
  SELECT
    m.recency_score,
    m.fm_score,
    count(*)::bigint AS customers_count
  FROM matrix_rows m
  GROUP BY m.recency_score, m.fm_score
  ORDER BY m.fm_score DESC, m.recency_score ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_analytics_rfm_score_matrix(UUID)
TO authenticated, service_role;
