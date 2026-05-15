-- Per-order financial reconciliation for admins: raw Shopify-synced columns plus KPI-aligned
-- effective amounts and heuristic flags for refund / sync edge cases.

CREATE OR REPLACE FUNCTION public.get_admin_order_financial_reconciliation_candidates(
  _from_iso timestamptz,
  _to_iso timestamptz,
  _only_flagged boolean DEFAULT true,
  _max_rows integer DEFAULT 500
)
RETURNS TABLE (
  order_id uuid,
  shopify_order_id text,
  order_number text,
  shopify_created_at timestamptz,
  financial_status text,
  status_norm text,
  total numeric,
  original_total numeric,
  current_total numeric,
  subtotal numeric,
  total_tax numeric,
  eff_orig numeric,
  eff_curr numeric,
  eff_tax numeric,
  crm_refunded_returned_value numeric,
  missing_current_total boolean,
  flag_reasons text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH params AS (
    SELECT least(greatest(coalesce(_max_rows, 500), 1), 2000)::int AS lim
  ),
  base AS (
    SELECT
      o.id AS order_id,
      o.shopify_order_id,
      o.order_number,
      o.shopify_created_at,
      o.financial_status,
      st.sn AS status_norm,
      o.total::numeric AS total,
      o.original_total::numeric AS original_total,
      o.current_total::numeric AS current_total,
      o.subtotal::numeric AS subtotal,
      o.total_tax::numeric AS total_tax,
      CASE
        WHEN st.sn = 'voided' THEN 0::numeric
        ELSE coalesce(o.original_total, o.total, 0)::numeric
      END AS eff_orig,
      CASE
        WHEN st.sn = 'voided' THEN 0::numeric
        ELSE coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric
      END AS eff_curr,
      CASE
        WHEN st.sn = 'voided' THEN 0::numeric
        ELSE coalesce(o.total_tax, 0)::numeric
      END AS eff_tax,
      CASE
        WHEN st.sn = 'voided' THEN 0::numeric
        ELSE greatest(
          coalesce(o.original_total, o.total, 0)::numeric
          - coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric,
          0::numeric
        )
      END AS crm_refunded_returned_value,
      (o.current_total IS NULL AND st.sn <> 'voided') AS missing_current_total,
      trim(both '; ' FROM concat_ws('; ',
        CASE
          WHEN o.current_total IS NULL AND st.sn <> 'voided' THEN 'missing_current_total'
          ELSE NULL::text
        END,
        CASE
          WHEN st.sn IN ('refunded', 'partially_refunded')
            AND greatest(
              coalesce(o.original_total, o.total, 0)::numeric
              - coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric,
              0::numeric
            ) < 0.02
          THEN 'refunded_status_minimal_refund_slice'
          ELSE NULL::text
        END,
        CASE
          WHEN o.original_total IS NULL
            AND o.total IS NOT NULL
            AND o.current_total IS NOT NULL
            AND abs(o.total::numeric - o.current_total::numeric) > 0.02
          THEN 'original_total_null_total_vs_current_differ'
          ELSE NULL::text
        END,
        CASE
          WHEN st.sn = 'voided'
            AND (
              coalesce(o.total, 0) <> 0
              OR coalesce(o.current_total, 0) <> 0
              OR coalesce(o.original_total, 0) <> 0
            )
          THEN 'voided_row_nonzero_amounts'
          ELSE NULL::text
        END,
        CASE
          WHEN st.sn <> 'voided'
            AND coalesce(o.current_total, coalesce(o.original_total, o.total), 0)::numeric
              > coalesce(o.original_total, o.total, 0)::numeric + 0.02
          THEN 'current_total_exceeds_effective_original'
          ELSE NULL::text
        END
      )) AS flag_reasons
    FROM public.shopify_orders o
    CROSS JOIN LATERAL (SELECT public.normalize_financial_status(o.financial_status) AS sn) st
    WHERE public.has_role(auth.uid(), 'admin')
      AND _from_iso IS NOT NULL
      AND _to_iso IS NOT NULL
      AND o.shopify_created_at >= _from_iso
      AND o.shopify_created_at <= _to_iso
      AND coalesce(o.test_order, false) = false
  ),
  ranked AS (
    SELECT b.*
    FROM base b
    WHERE (NOT _only_flagged OR (b.flag_reasons IS NOT NULL AND btrim(b.flag_reasons) <> ''))
    ORDER BY
      CASE WHEN btrim(b.flag_reasons) <> '' THEN 0 ELSE 1 END,
      (b.crm_refunded_returned_value + abs(b.eff_orig - b.eff_curr)) DESC,
      b.shopify_created_at DESC
    LIMIT (SELECT lim FROM params)
  )
  SELECT
    ranked.order_id,
    ranked.shopify_order_id,
    ranked.order_number,
    ranked.shopify_created_at,
    ranked.financial_status,
    ranked.status_norm,
    ranked.total,
    ranked.original_total,
    ranked.current_total,
    ranked.subtotal,
    ranked.total_tax,
    ranked.eff_orig,
    ranked.eff_curr,
    ranked.eff_tax,
    ranked.crm_refunded_returned_value,
    ranked.missing_current_total,
    ranked.flag_reasons
  FROM ranked;
$$;

COMMENT ON FUNCTION public.get_admin_order_financial_reconciliation_candidates(timestamptz, timestamptz, boolean, integer) IS
  'Admin-only: orders in [from,to] on shopify_created_at with raw totals and KPI-aligned refund slice; optional heuristic flags for sync investigation.';

GRANT EXECUTE ON FUNCTION public.get_admin_order_financial_reconciliation_candidates(timestamptz, timestamptz, boolean, integer)
  TO authenticated, service_role;
