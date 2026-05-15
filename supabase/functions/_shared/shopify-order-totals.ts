/**
 * Normalizes Shopify Admin GraphQL Order price sets into CRM columns.
 *
 * `originalTotalPriceSet` is usually the pre-return order ceiling, but Shopify can return
 * values below `totalPriceSet` / `currentTotalPriceSet` (deposits, B2B, multi-step checkout, API quirks).
 * Storing that raw value makes refund KPI math look impossible (current > "original").
 *
 * We persist `original_total` as max(totalPriceSet, currentTotalPriceSet, originalTotalPriceSet)
 * so it always matches a defensible pre-adjustment ceiling aligned with the other shop-money fields.
 */
export type ShopifyMoneyBag = {
  shopMoney?: { amount?: string | null; currencyCode?: string | null } | null;
} | null;

export type ShopifyOrderPriceNode = {
  totalPriceSet?: ShopifyMoneyBag;
  currentTotalPriceSet?: ShopifyMoneyBag;
  originalTotalPriceSet?: ShopifyMoneyBag;
};

function parseAmount(amount: string | null | undefined, fallback: number): number {
  if (amount == null || String(amount).trim() === "") return fallback;
  const n = parseFloat(String(amount));
  return Number.isFinite(n) ? n : fallback;
}

export function mapShopifyOrderMoneyFields(node: ShopifyOrderPriceNode): {
  total: number;
  original_total: number;
  current_total: number;
} {
  const total = parseAmount(node.totalPriceSet?.shopMoney?.amount, 0);
  const currentStr = node.currentTotalPriceSet?.shopMoney?.amount;
  const current_total =
    currentStr != null && String(currentStr).trim() !== ""
      ? parseAmount(currentStr, 0)
      : total;
  const origStr = node.originalTotalPriceSet?.shopMoney?.amount;
  const fromOriginalApi =
    origStr != null && String(origStr).trim() !== "" ? parseAmount(origStr, 0) : null;
  const original_total = Math.max(total, current_total, fromOriginalApi ?? 0);
  return { total, original_total, current_total };
}
