-- Avoid PostgREST URL offset/limit on RPC endpoints for large scopes.
-- Expose explicit paged RPCs with _offset/_limit args.

CREATE OR REPLACE FUNCTION public.get_scoped_customer_ids_for_salespeople_paged(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _offset INTEGER DEFAULT 0,
  _limit INTEGER DEFAULT 1000
)
RETURNS TABLE (
  customer_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.customer_id
  FROM public.get_scoped_customer_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids) t
  ORDER BY t.customer_id
  OFFSET GREATEST(coalesce(_offset, 0), 0)
  LIMIT GREATEST(coalesce(_limit, 1000), 1);
$$;

GRANT EXECUTE ON FUNCTION public.get_scoped_customer_ids_for_salespeople_paged(UUID, UUID[], INTEGER, INTEGER)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_scoped_order_ids_for_salespeople_paged(
  _viewer_user_id UUID,
  _salesperson_user_ids UUID[] DEFAULT NULL,
  _offset INTEGER DEFAULT 0,
  _limit INTEGER DEFAULT 1000
)
RETURNS TABLE (
  order_id UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.order_id
  FROM public.get_scoped_order_ids_for_salespeople(_viewer_user_id, _salesperson_user_ids) t
  ORDER BY t.order_id
  OFFSET GREATEST(coalesce(_offset, 0), 0)
  LIMIT GREATEST(coalesce(_limit, 1000), 1);
$$;

GRANT EXECUTE ON FUNCTION public.get_scoped_order_ids_for_salespeople_paged(UUID, UUID[], INTEGER, INTEGER)
TO authenticated, service_role;
