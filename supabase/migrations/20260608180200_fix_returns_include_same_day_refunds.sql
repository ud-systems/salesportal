-- Shopify returns: all refunds by processed_at in period (including same-day order refunds).

CREATE OR REPLACE FUNCTION public.shopify_analytics_returns_for_scope(
  _from_iso timestamptz,
  _to_iso timestamptz,
  _in_period_order_ids uuid[],
  _all_scoped_order_ids uuid[]
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH refund_event_returns AS (
    SELECT coalesce(sum(re.amount), 0)::numeric AS amt
    FROM public.shopify_refund_events re
    INNER JOIN unnest(_all_scoped_order_ids) s(id) ON s.id = re.order_id
    WHERE (_from_iso IS NULL OR re.processed_at >= _from_iso)
      AND (_to_iso IS NULL OR re.processed_at <= _to_iso)
  ),
  refund_delta_returns AS (
    SELECT coalesce(sum(d.amount), 0)::numeric AS amt
    FROM public.shopify_order_refund_deltas d
    INNER JOIN unnest(_all_scoped_order_ids) s(id) ON s.id = d.order_id
    WHERE (_from_iso IS NULL OR d.recorded_at >= _from_iso)
      AND (_to_iso IS NULL OR d.recorded_at <= _to_iso)
      AND NOT EXISTS (
        SELECT 1
        FROM public.shopify_refund_events re
        WHERE re.order_id = d.order_id
          AND (_from_iso IS NULL OR re.processed_at >= _from_iso)
          AND (_to_iso IS NULL OR re.processed_at <= _to_iso)
      )
  ),
  in_period_fallback_returns AS (
    SELECT coalesce(sum(
      public.shopify_order_effective_returns(
        o.financial_status,
        o.total,
        o.current_total,
        o.original_total,
        o.reporting_total_refunded
      )
    ), 0)::numeric AS amt
    FROM public.shopify_orders o
    INNER JOIN unnest(_in_period_order_ids) s(id) ON s.id = o.id
    WHERE public.normalize_financial_status(o.financial_status) <> 'voided'
      AND NOT EXISTS (
        SELECT 1
        FROM public.shopify_refund_events re
        WHERE re.order_id = o.id
          AND (_from_iso IS NULL OR re.processed_at >= _from_iso)
          AND (_to_iso IS NULL OR re.processed_at <= _to_iso)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.shopify_order_refund_deltas d
        WHERE d.order_id = o.id
          AND (_from_iso IS NULL OR d.recorded_at >= _from_iso)
          AND (_to_iso IS NULL OR d.recorded_at <= _to_iso)
      )
  )
  SELECT round(
    (SELECT amt FROM refund_event_returns)
    + (SELECT amt FROM refund_delta_returns)
    + (SELECT amt FROM in_period_fallback_returns),
    2
  );
$$;
