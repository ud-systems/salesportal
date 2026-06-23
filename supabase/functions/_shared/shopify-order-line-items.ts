/** Map Shopify Admin GraphQL line items, excluding removed/refunded units (currentQuantity = 0). */

export type GraphqlLineItemNode = {
  id?: string;
  title?: string;
  variantTitle?: string;
  quantity?: number;
  currentQuantity?: number;
  sku?: string | null;
  variant?: { id?: string; sku?: string | null } | null;
  originalUnitPriceSet?: { shopMoney?: { amount?: string } };
};

export function activeLineItemQuantity(node: GraphqlLineItemNode): number {
  if (node.currentQuantity != null && Number.isFinite(Number(node.currentQuantity))) {
    return Math.max(0, Number(node.currentQuantity));
  }
  return Math.max(0, Number(node.quantity ?? 0));
}

export function mapGraphqlLineItemEdgesToRows(
  edges: Array<{ node: Record<string, unknown> }> | undefined | null,
  orderId: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const e of edges || []) {
    const n = e.node as GraphqlLineItemNode;
    const qty = activeLineItemQuantity(n);
    if (qty <= 0) continue;
    rows.push({
      order_id: orderId,
      shopify_line_item_id: n.id ? String(n.id).replace("gid://shopify/LineItem/", "") : null,
      shopify_variant_gid: n.variant?.id || null,
      product: n.title || null,
      variant: n.variantTitle || "Default",
      sku: n.variant?.sku || n.sku || null,
      quantity: qty,
      price: parseFloat(n.originalUnitPriceSet?.shopMoney?.amount || "0"),
    });
  }
  return rows;
}

/** Line-item rows for bulk sync before internal order UUID is known. */
export function mapGraphqlLineItemEdgesToPayload(
  edges: Array<{ node: Record<string, unknown> }> | undefined | null,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const e of edges || []) {
    const n = e.node as GraphqlLineItemNode;
    const qty = activeLineItemQuantity(n);
    if (qty <= 0) continue;
    const variantGid = n.variant?.id || null;
    const lineGid = n.id?.replace("gid://shopify/LineItem/", "") || null;
    rows.push({
      shopify_line_item_id: lineGid,
      shopify_variant_gid: variantGid,
      product: n.title,
      variant: n.variantTitle || "Default",
      sku: n.variant?.sku || n.sku || null,
      quantity: qty,
      price: parseFloat(n.originalUnitPriceSet?.shopMoney?.amount || "0"),
    });
  }
  return rows;
}
