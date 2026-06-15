-- PostgREST 400: ambiguous RPC when multiple get_scoped_orders_page overloads exist.
-- Keep only the latest signature (with _customer_ids + _filter_by_reporting_day).

DROP FUNCTION IF EXISTS public.get_scoped_orders_page(
  uuid, uuid[], text[], text, text, text, timestamptz, timestamptz, text, text, integer, integer, boolean
);

DROP FUNCTION IF EXISTS public.get_scoped_order_items_page(
  uuid, uuid[], text[], timestamptz, timestamptz, integer, integer, boolean
);
