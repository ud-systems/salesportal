-- Prefer reporting_line_items_gross before summing shopify_order_items per order.

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
      coalesce(_reporting_line_items_gross, public.shopify_order_line_items_gross(_order_id), 0)
        - coalesce(_subtotal, 0),
      0
    ), 0),
    0
  )::numeric;
$$;
