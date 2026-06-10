-- Shopify Analytics RPC alignment using live ingested data (no manual sync).
-- Returns: refund processed_at from webhook-backed events (matches Shopify ~£2,765 today).
-- Taxes: 20% VAT on net merchandise (gross - discounts - returns) for ex-VAT orders.
-- Discounts: coalesce(GraphQL totalDiscountsSet column, current discounts, line-item delta).

-- ---------------------------------------------------------------------------
-- Refund events (Shopify Analytics returns by refund processed date)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shopify_refund_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_refund_id BIGINT NOT NULL,
  order_id UUID NOT NULL REFERENCES public.shopify_orders(id) ON DELETE CASCADE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  processed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shopify_refund_id)
);

CREATE INDEX IF NOT EXISTS idx_shopify_refund_events_processed_at
  ON public.shopify_refund_events(processed_at);

CREATE INDEX IF NOT EXISTS idx_shopify_refund_events_order_id
  ON public.shopify_refund_events(order_id);

ALTER TABLE public.shopify_refund_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view refund events" ON public.shopify_refund_events;
CREATE POLICY "Admins can view refund events"
  ON public.shopify_refund_events FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

GRANT SELECT ON public.shopify_refund_events TO authenticated;
GRANT ALL ON public.shopify_refund_events TO service_role;

CREATE OR REPLACE FUNCTION public.shopify_refund_event_amount_from_json(_refund jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT round(
    coalesce((
      SELECT sum(coalesce((x->>'subtotal')::numeric, 0))
      FROM jsonb_array_elements(coalesce(_refund->'refund_line_items', '[]'::jsonb)) x
    ), 0)
    + coalesce((
      SELECT sum(abs(coalesce((a->>'amount')::numeric, 0)))
      FROM jsonb_array_elements(coalesce(_refund->'order_adjustments', '[]'::jsonb)) a
    ), 0),
    2
  );
$$;

-- Backfill refund events from stored webhook payloads (idempotent).
INSERT INTO public.shopify_refund_events (shopify_refund_id, order_id, amount, processed_at)
SELECT DISTINCT ON ((r.refund->>'id')::bigint)
  (r.refund->>'id')::bigint,
  o.id,
  public.shopify_refund_event_amount_from_json(r.refund),
  (r.refund->>'processed_at')::timestamptz
FROM public.shopify_webhook_events e
CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.payload->'refunds', '[]'::jsonb)) AS r(refund)
INNER JOIN public.shopify_orders o
  ON o.shopify_order_id = (e.payload->>'id')::text
WHERE e.topic = 'orders/updated'
  AND (r.refund->>'id') IS NOT NULL
  AND (r.refund->>'processed_at') IS NOT NULL
  AND public.shopify_refund_event_amount_from_json(r.refund) > 0
ORDER BY (r.refund->>'id')::bigint, e.received_at DESC
ON CONFLICT (shopify_refund_id) DO NOTHING;

-- Keep refund_deltas in sync when reporting_total_refunded increases (webhook live path).
CREATE OR REPLACE FUNCTION public.trg_shopify_orders_refund_delta()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND coalesce(NEW.reporting_total_refunded, 0) > coalesce(OLD.reporting_total_refunded, 0) THEN
    INSERT INTO public.shopify_order_refund_deltas (order_id, amount, recorded_at)
    VALUES (
      NEW.id,
      round((coalesce(NEW.reporting_total_refunded, 0) - coalesce(OLD.reporting_total_refunded, 0))::numeric, 2),
      now()
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shopify_orders_refund_delta ON public.shopify_orders;
CREATE TRIGGER shopify_orders_refund_delta
  AFTER UPDATE OF reporting_total_refunded ON public.shopify_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_shopify_orders_refund_delta();

-- Backfill original discounts from first orders/create webhook (REST total_discounts).
UPDATE public.shopify_orders o
SET reporting_original_total_discounts = wh.td
FROM (
  SELECT DISTINCT ON (e.payload->>'name')
    e.payload->>'name' AS order_number,
    (e.payload->>'total_discounts')::numeric AS td
  FROM public.shopify_webhook_events e
  WHERE e.topic = 'orders/create'
    AND e.payload->>'name' IS NOT NULL
    AND (e.payload->>'total_discounts') IS NOT NULL
  ORDER BY e.payload->>'name', e.received_at ASC
) wh
WHERE o.order_number = wh.order_number
  AND o.reporting_original_total_discounts IS NULL
  AND wh.td > 0;

-- ---------------------------------------------------------------------------
-- Per-order analytics helpers (immutable)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.shopify_order_line_items_gross(_order_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT round(coalesce(sum(coalesce(i.price, 0) * coalesce(i.quantity, 0)), 0)::numeric, 2)
  FROM public.shopify_order_items i
  WHERE i.order_id = _order_id;
$$;

CREATE OR REPLACE FUNCTION public.shopify_order_analytics_gross(
  _subtotal numeric,
  _reporting_line_items_gross numeric
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(_subtotal, _reporting_line_items_gross, 0)::numeric;
$$;

CREATE OR REPLACE FUNCTION public.shopify_order_analytics_discount(
  _order_id uuid,
  _subtotal numeric,
  _reporting_original_total_discounts numeric,
  _reporting_total_discounts numeric,
  _reporting_line_items_gross numeric
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    NULLIF(coalesce(_reporting_original_total_discounts, 0), 0),
    NULLIF(coalesce(_reporting_total_discounts, 0), 0),
    NULLIF(greatest(
      coalesce(public.shopify_order_line_items_gross(_order_id), _reporting_line_items_gross, 0)
        - coalesce(_subtotal, 0),
      0
    ), 0),
    0
  )::numeric;
$$;

CREATE OR REPLACE FUNCTION public.shopify_analytics_vat_rate()
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    nullif(
      (SELECT value::numeric FROM public.app_settings WHERE key = 'shopify_analytics_vat_rate' LIMIT 1),
      0
    ),
    0.20::numeric
  );
$$;

CREATE OR REPLACE FUNCTION public.shopify_analytics_returns_for_scope(
  _from_iso timestamptz,
  _to_iso timestamptz,
  _scoped_order_ids uuid[]
)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH in_period_order_returns AS (
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
    INNER JOIN unnest(_scoped_order_ids) s(id) ON s.id = o.id
    WHERE public.normalize_financial_status(o.financial_status) <> 'voided'
  ),
  refund_date_returns AS (
    SELECT coalesce(sum(re.amount), 0)::numeric AS amt
    FROM public.shopify_refund_events re
    INNER JOIN unnest(_scoped_order_ids) s(id) ON s.id = re.order_id
    INNER JOIN public.shopify_orders o ON o.id = re.order_id
    WHERE (_from_iso IS NULL OR re.processed_at >= _from_iso)
      AND (_to_iso IS NULL OR re.processed_at <= _to_iso)
      AND (
        _from_iso IS NULL OR _to_iso IS NULL
        OR o.shopify_created_at < _from_iso
        OR o.shopify_created_at > _to_iso
      )
  ),
  refund_deltas AS (
    SELECT coalesce(sum(d.amount), 0)::numeric AS amt
    FROM public.shopify_order_refund_deltas d
    INNER JOIN unnest(_scoped_order_ids) s(id) ON s.id = d.order_id
    INNER JOIN public.shopify_orders o ON o.id = d.order_id
    WHERE (_from_iso IS NULL OR d.recorded_at >= _from_iso)
      AND (_to_iso IS NULL OR d.recorded_at <= _to_iso)
      AND (
        _from_iso IS NULL OR _to_iso IS NULL
        OR o.shopify_created_at < _from_iso
        OR o.shopify_created_at > _to_iso
      )
  )
  SELECT round(
    (SELECT amt FROM in_period_order_returns)
    + greatest((SELECT amt FROM refund_date_returns), (SELECT amt FROM refund_deltas)),
    2
  );
$$;

-- ---------------------------------------------------------------------------
-- Breakdown RPCs (Shopify Analytics formula)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_scope_shopify_sales_breakdown(
  _viewer_user_id UUID,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  gross_sales_line_list NUMERIC(14,2),
  discounts NUMERIC(14,2),
  returns_refunded NUMERIC(14,2),
  net_sales_derived NUMERIC(14,2),
  shipping NUMERIC(14,2),
  taxes NUMERIC(14,2),
  total_sales_check NUMERIC(14,2),
  orders_in_scope BIGINT,
  orders_missing_reporting BIGINT
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
  admin_order_ids AS (
    SELECT o.id
    FROM public.shopify_orders o
    CROSS JOIN viewer_flags vf
    WHERE vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_order_ids_direct AS (
    SELECT o.id
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_order_ids_fallback AS (
    SELECT o.id
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
    CROSS JOIN viewer_flags vf
    WHERE NOT vf.is_admin
      AND (_from_iso IS NULL OR o.shopify_created_at >= _from_iso)
      AND (_to_iso IS NULL OR o.shopify_created_at <= _to_iso)
      AND coalesce(o.test_order, false) = false
  ),
  scoped_order_ids AS (
    SELECT DISTINCT id FROM (
      SELECT id FROM admin_order_ids
      UNION ALL
      SELECT id FROM scoped_order_ids_direct
      UNION ALL
      SELECT id FROM scoped_order_ids_fallback
    ) u
  ),
  lines AS (
    SELECT
      o.id AS o_id,
      public.normalize_financial_status(o.financial_status) AS st,
      public.shopify_order_analytics_gross(o.subtotal, o.reporting_line_items_gross) AS line_gross_raw,
      public.shopify_order_analytics_discount(
        o.id,
        o.subtotal,
        o.reporting_original_total_discounts,
        o.reporting_total_discounts,
        o.reporting_line_items_gross
      ) AS disc_raw,
      coalesce(o.reporting_total_shipping, 0)::numeric AS ship_raw,
      o.subtotal AS r_subtotal,
      o.reporting_line_items_gross AS r_gross
    FROM public.shopify_orders o
    INNER JOIN scoped_order_ids s ON s.id = o.id
  ),
  normed AS (
    SELECT
      o_id AS id,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE line_gross_raw END AS line_gross,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE disc_raw END AS disc,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE ship_raw END AS ship,
      (st <> 'voided' AND r_subtotal IS NULL AND r_gross IS NULL) AS missing_row
    FROM lines
  ),
  rolled AS (
    SELECT
      coalesce(sum(line_gross), 0)::numeric AS sum_gross,
      coalesce(sum(disc), 0)::numeric AS sum_disc,
      coalesce(sum(ship), 0)::numeric AS sum_ship,
      count(*)::bigint AS cnt,
      count(*) FILTER (WHERE missing_row)::bigint AS missing_cnt
    FROM normed
  ),
  returns_amt AS (
    SELECT public.shopify_analytics_returns_for_scope(
      _from_iso,
      _to_iso,
      ARRAY(SELECT id FROM scoped_order_ids)
    ) AS amt
  ),
  net AS (
    SELECT
      r.sum_gross - r.sum_disc - ra.amt AS net_sales
    FROM rolled r
    CROSS JOIN returns_amt ra
  )
  SELECT
    r.sum_gross::numeric(14,2) AS gross_sales_line_list,
    r.sum_disc::numeric(14,2) AS discounts,
    ra.amt::numeric(14,2) AS returns_refunded,
    n.net_sales::numeric(14,2) AS net_sales_derived,
    r.sum_ship::numeric(14,2) AS shipping,
    round((n.net_sales * public.shopify_analytics_vat_rate())::numeric, 2)::numeric(14,2) AS taxes,
  (
    n.net_sales + round((n.net_sales * public.shopify_analytics_vat_rate())::numeric, 2) + r.sum_ship
  )::numeric(14,2) AS total_sales_check,
    r.cnt AS orders_in_scope,
    r.missing_cnt AS orders_missing_reporting
  FROM rolled r
  CROSS JOIN returns_amt ra
  CROSS JOIN net n;
$$;

CREATE OR REPLACE FUNCTION public.get_selected_salespeople_shopify_sales_breakdown(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _from_iso TIMESTAMPTZ DEFAULT NULL,
  _to_iso TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  gross_sales_line_list NUMERIC(14,2),
  discounts NUMERIC(14,2),
  returns_refunded NUMERIC(14,2),
  net_sales_derived NUMERIC(14,2),
  shipping NUMERIC(14,2),
  taxes NUMERIC(14,2),
  total_sales_check NUMERIC(14,2),
  orders_in_scope BIGINT,
  orders_missing_reporting BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped_customer_ids AS (
    SELECT customer_id
    FROM public.get_scoped_customer_ids_for_salespeople(
      _viewer_user_id,
      _salesperson_user_ids
    )
  ),
  scoped_customers AS (
    SELECT c.id AS customer_id, c.shopify_customer_id
    FROM public.shopify_customers c
    INNER JOIN scoped_customer_ids sci ON sci.customer_id = c.id
  ),
  order_rows AS (
    SELECT
      o.id,
      o.financial_status,
      o.subtotal,
      o.reporting_line_items_gross,
      o.reporting_original_total_discounts,
      o.reporting_total_discounts,
      o.reporting_total_shipping
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc ON o.customer_id = sc.customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) <= _to_iso)
    UNION ALL
    SELECT
      o.id,
      o.financial_status,
      o.subtotal,
      o.reporting_line_items_gross,
      o.reporting_original_total_discounts,
      o.reporting_total_discounts,
      o.reporting_total_shipping
    FROM public.shopify_orders o
    INNER JOIN scoped_customers sc
      ON o.customer_id IS NULL
      AND o.shopify_customer_id IS NOT NULL
      AND sc.shopify_customer_id IS NOT NULL
      AND o.shopify_customer_id = sc.shopify_customer_id
    WHERE coalesce(o.test_order, false) = false
      AND (_from_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) >= _from_iso)
      AND (_to_iso IS NULL OR coalesce(o.shopify_created_at, o.created_at) <= _to_iso)
  ),
  scoped_orders AS (
    SELECT DISTINCT ON (id) * FROM order_rows ORDER BY id
  ),
  scoped_order_ids AS (
    SELECT id FROM scoped_orders
  ),
  lines AS (
    SELECT
      id AS o_id,
      public.normalize_financial_status(financial_status) AS st,
      public.shopify_order_analytics_gross(subtotal, reporting_line_items_gross) AS line_gross_raw,
      public.shopify_order_analytics_discount(
        id,
        subtotal,
        reporting_original_total_discounts,
        reporting_total_discounts,
        reporting_line_items_gross
      ) AS disc_raw,
      coalesce(reporting_total_shipping, 0)::numeric AS ship_raw,
      subtotal AS r_subtotal,
      reporting_line_items_gross AS r_gross
    FROM scoped_orders
  ),
  normed AS (
    SELECT
      o_id AS id,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE line_gross_raw END AS line_gross,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE disc_raw END AS disc,
      CASE WHEN st = 'voided' THEN 0::numeric ELSE ship_raw END AS ship,
      (st <> 'voided' AND r_subtotal IS NULL AND r_gross IS NULL) AS missing_row
    FROM lines
  ),
  rolled AS (
    SELECT
      coalesce(sum(line_gross), 0)::numeric AS sum_gross,
      coalesce(sum(disc), 0)::numeric AS sum_disc,
      coalesce(sum(ship), 0)::numeric AS sum_ship,
      count(*)::bigint AS cnt,
      count(*) FILTER (WHERE missing_row)::bigint AS missing_cnt
    FROM normed
  ),
  returns_amt AS (
    SELECT public.shopify_analytics_returns_for_scope(
      _from_iso,
      _to_iso,
      ARRAY(SELECT id FROM scoped_order_ids)
    ) AS amt
  ),
  net AS (
    SELECT r.sum_gross - r.sum_disc - ra.amt AS net_sales
    FROM rolled r
    CROSS JOIN returns_amt ra
  )
  SELECT
    r.sum_gross::numeric(14,2),
    r.sum_disc::numeric(14,2),
    ra.amt::numeric(14,2),
    n.net_sales::numeric(14,2),
    r.sum_ship::numeric(14,2),
    round((n.net_sales * public.shopify_analytics_vat_rate())::numeric, 2)::numeric(14,2),
    (
      n.net_sales + round((n.net_sales * public.shopify_analytics_vat_rate())::numeric, 2) + r.sum_ship
    )::numeric(14,2),
    r.cnt,
    r.missing_cnt
  FROM rolled r
  CROSS JOIN returns_amt ra
  CROSS JOIN net n;
$$;

GRANT EXECUTE ON FUNCTION public.shopify_order_line_items_gross(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_order_analytics_gross(numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_order_analytics_discount(uuid, numeric, numeric, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_analytics_vat_rate() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_analytics_returns_for_scope(timestamptz, timestamptz, uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.shopify_refund_event_amount_from_json(jsonb) TO authenticated, service_role;
