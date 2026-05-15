-- Repair rows where original_total was stored below both total and current_total (Shopify API
-- originalTotalPriceSet can be a deposit/partial figure; ingestion now clamps to max of the three).
-- Voided orders are left unchanged (KPIs zero them separately).

UPDATE public.shopify_orders o
SET original_total = round(
  greatest(
    coalesce(o.total, 0)::numeric,
    coalesce(o.current_total, 0)::numeric,
    coalesce(o.original_total, 0)::numeric
  ),
  2
)
WHERE coalesce(o.test_order, false) = false
  AND public.normalize_financial_status(o.financial_status) <> 'voided'
  AND coalesce(o.original_total, 0)::numeric + 0.02
    < greatest(coalesce(o.total, 0)::numeric, coalesce(o.current_total, 0)::numeric);

COMMENT ON COLUMN public.shopify_orders.original_total IS
  'Shopify Order originalTotalPriceSet (shop money), clamped on ingest to max(originalTotalPriceSet, totalPriceSet, currentTotalPriceSet) so it never understates the order ceiling vs total/current.';
