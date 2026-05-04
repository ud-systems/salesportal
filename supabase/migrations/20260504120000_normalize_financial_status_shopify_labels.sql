-- Match client-side normalization in src/hooks/use-shopify-data.ts (normalizeFinancialStatus).
-- Human-readable Shopify labels use spaces; GraphQL enums use underscores. Without mapping
-- "partially refunded" -> partially_refunded, refunded_amount stays 0 and net_revenue equals gross.

CREATE OR REPLACE FUNCTION public.normalize_financial_status(_status TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN _status IS NULL OR btrim(_status) = '' THEN 'unknown'
    WHEN lower(btrim(_status)) = 'partially paid' THEN 'partially_paid'
    WHEN lower(btrim(_status)) = 'partially refunded' THEN 'partially_refunded'
    WHEN lower(btrim(_status)) IN ('paid', 'partially_paid') THEN lower(btrim(_status))
    WHEN lower(btrim(_status)) IN ('pending', 'authorized') THEN lower(btrim(_status))
    WHEN lower(btrim(_status)) IN ('refunded', 'partially_refunded', 'voided') THEN lower(btrim(_status))
    ELSE lower(btrim(_status))
  END
$$;
