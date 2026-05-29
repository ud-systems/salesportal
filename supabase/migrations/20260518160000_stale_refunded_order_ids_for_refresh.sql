-- Orders where refund-related status is set but current_total still equals total (totals often settle after status).
-- Used by shopify-sync targeted refresh (service role only).

CREATE OR REPLACE FUNCTION public.get_shopify_order_ids_stale_refunded_totals(_limit integer DEFAULT 25)
RETURNS TABLE (shopify_order_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.shopify_order_id::text
  FROM public.shopify_orders o
  WHERE coalesce(o.test_order, false) = false
    AND public.normalize_financial_status(o.financial_status) IN ('refunded', 'partially_refunded')
    AND o.current_total IS NOT NULL
    AND o.total IS NOT NULL
    AND abs(o.current_total::numeric - o.total::numeric) < 0.02
  ORDER BY
    o.updated_at DESC NULLS LAST,
    o.shopify_created_at DESC NULLS LAST
  LIMIT least(greatest(coalesce(_limit, 25), 1), 100);
$$;

COMMENT ON FUNCTION public.get_shopify_order_ids_stale_refunded_totals(integer) IS
  'Service-role helper: Shopify order IDs where refund-like status may have arrived before totals diverged; queue for live re-fetch.';

REVOKE ALL ON FUNCTION public.get_shopify_order_ids_stale_refunded_totals(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shopify_order_ids_stale_refunded_totals(integer) TO service_role;
