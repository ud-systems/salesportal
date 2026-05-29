/** Shopify Order reporting fields for Analytics-style breakdown (Layer 2). */

export function shopMoneyAmount(bag: unknown): number | null {
  if (!bag || typeof bag !== "object") return null;
  const sm = (bag as { shopMoney?: { amount?: string | null } | null }).shopMoney;
  if (sm?.amount == null || String(sm.amount).trim() === "") return null;
  const n = parseFloat(String(sm.amount));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function sumLineItemsListGross(lineItemsRoot: unknown): number {
  const edges = (lineItemsRoot as { edges?: { node: Record<string, unknown> }[] } | null)?.edges || [];
  let sum = 0;
  for (const e of edges) {
    const n = e.node as {
      quantity?: number;
      originalUnitPriceSet?: { shopMoney?: { amount?: string | null } | null } | null;
    };
    const q = Number(n.quantity ?? 0);
    const unitRaw = n.originalUnitPriceSet?.shopMoney?.amount;
    const unit = unitRaw != null && String(unitRaw).trim() !== "" ? parseFloat(String(unitRaw)) : 0;
    if (Number.isFinite(q) && Number.isFinite(unit)) sum += q * unit;
  }
  return Math.round(sum * 100) / 100;
}

export type OrderReportingRow = {
  reporting_line_items_gross: number;
  reporting_total_discounts: number | null;
  reporting_total_shipping: number | null;
  reporting_total_refunded: number | null;
  taxes_included: boolean | null;
};

/**
 * Maps Shopify Admin GraphQL `order` node fields (2025-01) into CRM reporting columns.
 * Gross merchandise (pre-discount list): Σ(originalUnitPrice × qty) over line items.
 */
export function extractOrderReportingFields(orderNode: Record<string, unknown>): OrderReportingRow {
  const lineGross = sumLineItemsListGross(orderNode.lineItems);
  return {
    reporting_line_items_gross: lineGross,
    reporting_total_discounts: shopMoneyAmount(orderNode.currentTotalDiscountsSet),
    reporting_total_shipping: shopMoneyAmount(orderNode.currentShippingPriceSet),
    reporting_total_refunded: shopMoneyAmount(orderNode.totalRefundedSet),
    taxes_included: typeof orderNode.taxesIncluded === "boolean" ? orderNode.taxesIncluded : null,
  };
}
