/**
 * DataPulseFlow — shared Shopify ingestion module
 * Licensed component — https://datapulseflow.com
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { mapShopifyOrderMoneyFields, type ShopifyOrderPriceNode } from "./shopify-order-totals.ts";
import { extractOrderReportingFields, parseOrderSubtotalFromNode } from "./shopify-order-reporting.ts";
import { recordRefundDeltaIfIncreased } from "./shopify-order-refund-delta.ts";
import { mapGraphqlLineItemEdgesToRows } from "./shopify-order-line-items.ts";

/** Admin GraphQL: single order with money + line items (same shape as shopify-webhook). */
export const SHOPIFY_ORDER_DETAIL_GQL = `query($id: ID!) {
  order(id: $id) {
    id
    name
    email
    currencyCode
    test
    note
    tags
    createdAt
    processedAt
    displayFinancialStatus
    displayFulfillmentStatus
    edited
    taxesIncluded
    subtotalPriceSet { shopMoney { amount } }
    currentSubtotalPriceSet { shopMoney { amount } }
    currentTotalTaxSet { shopMoney { amount } }
    totalPriceSet { shopMoney { amount currencyCode } }
    originalTotalPriceSet { shopMoney { amount } }
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    totalDiscountsSet { shopMoney { amount } }
    currentTotalDiscountsSet { shopMoney { amount } }
    currentShippingPriceSet { shopMoney { amount } }
    totalRefundedSet { shopMoney { amount } }
    fulfillments {
      id
      status
      trackingInfo {
        company
        number
        url
      }
      createdAt
      updatedAt
    }
    shippingAddress {
      name
      address1
      address2
      city
      province
      countryCodeV2
      zip
      phone
    }
    customer { id displayName defaultEmailAddress { emailAddress } }
    lineItems(first: 100) {
      edges {
        node {
          id
          title
          variantTitle
          quantity
          currentQuantity
          sku
          variant { id sku }
          originalUnitPriceSet { shopMoney { amount } }
        }
      }
    }
  }
}`;

export type OrderCustomerResolver = (customerGid: string | null) => Promise<string | null>;

function extractShippingFields(orderNode: Record<string, unknown>) {
  const addr = orderNode.shippingAddress as {
    name?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    countryCodeV2?: string | null;
    zip?: string | null;
  } | null | undefined;
  if (!addr) {
    return {
      shipping_name: null,
      shipping_address1: null,
      shipping_address2: null,
      shipping_city: null,
      shipping_province: null,
      shipping_country: null,
      shipping_zip: null,
    };
  }
  return {
    shipping_name: addr.name || null,
    shipping_address1: addr.address1 || null,
    shipping_address2: addr.address2 || null,
    shipping_city: addr.city || null,
    shipping_province: addr.province || null,
    shipping_country: addr.countryCodeV2 || null,
    shipping_zip: addr.zip || null,
  };
}

type ShopifyTrackingInfo = {
  company?: string | null;
  number?: string | null;
  url?: string | null;
};

type ShopifyFulfillmentNode = {
  id?: string | null;
  status?: string | null;
  trackingInfo?: ShopifyTrackingInfo[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

function extractFulfillmentRows(orderNode: Record<string, unknown>, orderId: string | null) {
  const fulfillments = ((orderNode as {
    fulfillments?: ShopifyFulfillmentNode[] | null;
  }).fulfillments || []) as ShopifyFulfillmentNode[];

  const rows: Array<Record<string, unknown>> = [];
  for (const node of fulfillments) {
    if (!node?.id) continue;
    const shopifyFulfillmentId = String(node.id).replace("gid://shopify/Fulfillment/", "");
    const trackingEntries = Array.isArray(node.trackingInfo) ? node.trackingInfo : [];
    if (trackingEntries.length === 0) {
      rows.push({
        order_id: orderId,
        shopify_fulfillment_id: shopifyFulfillmentId,
        shipment_status: node.status ? String(node.status).toLowerCase() : null,
        tracking_company: null,
        tracking_number: null,
        tracking_url: null,
        fulfilled_at: node.createdAt || null,
        raw_payload: node as unknown as Record<string, unknown>,
      });
      continue;
    }
    for (const tracking of trackingEntries) {
      rows.push({
        order_id: orderId,
        shopify_fulfillment_id: tracking?.number
          ? `${shopifyFulfillmentId}:${String(tracking.number)}`
          : shopifyFulfillmentId,
        shipment_status: node.status ? String(node.status).toLowerCase() : null,
        tracking_company: tracking?.company || null,
        tracking_number: tracking?.number || null,
        tracking_url: tracking?.url || null,
        fulfilled_at: node.createdAt || null,
        raw_payload: node as unknown as Record<string, unknown>,
      });
    }
  }
  return rows;
}

function pickLatestTrackingSummary(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) {
    return {
      latest_tracking_number: null,
      latest_tracking_url: null,
      latest_tracking_company: null,
      latest_tracking_status: null,
      latest_fulfillment_updated_at: null,
    };
  }
  const latest = rows
    .slice()
    .sort((a, b) =>
      String(b.fulfilled_at || "").localeCompare(String(a.fulfilled_at || "")),
    )[0];
  return {
    latest_tracking_number: (latest.tracking_number as string | null) || null,
    latest_tracking_url: (latest.tracking_url as string | null) || null,
    latest_tracking_company: (latest.tracking_company as string | null) || null,
    latest_tracking_status: (latest.shipment_status as string | null) || null,
    latest_fulfillment_updated_at: (latest.fulfilled_at as string | null) || null,
  };
}

function dedupeFulfillmentRows(rows: Array<Record<string, unknown>>) {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const key = `${String(row.order_id || "")}::${String(row.shopify_fulfillment_id || "")}`;
    if (!row.shopify_fulfillment_id) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Upserts shopify_orders + shopify_order_items from a GraphQL `order` node.
 * Caller supplies how to resolve internal customer UUID (full customer sync vs lookup-only).
 */
export type ShopifyOrderUpsertOptions = {
  /** REST webhook `total_discounts` — original discounts at order creation when GraphQL column is empty. */
  reportingOriginalTotalDiscountsOverride?: number | null;
};

export async function upsertShopifyOrderFromGraphqlNode(
  supabase: SupabaseClient,
  orderNode: Record<string, unknown> | null | undefined,
  resolveCustomerUuid: OrderCustomerResolver,
  options?: ShopifyOrderUpsertOptions,
): Promise<{ orderId: string; shopify_order_id: string } | null> {
  const o = orderNode;
  if (!o?.id) return null;

  const shopifyOrderId = String(o.id).replace("gid://shopify/Order/", "");
  const customerGid = o.customer && typeof (o.customer as { id?: string }).id === "string"
    ? String((o.customer as { id: string }).id)
    : null;
  const shopifyCustomerId = customerGid ? customerGid.replace("gid://shopify/Customer/", "") : null;

  let customerUuid: string | null = null;
  if (customerGid) {
    customerUuid = await resolveCustomerUuid(customerGid);
  }

  const cust = (o.customer || {}) as {
    displayName?: string;
    defaultEmailAddress?: { emailAddress?: string | null };
  };
  const orderTags = Array.isArray(o.tags) ? (o.tags as unknown[]).join(", ") : "";
  const rep = extractOrderReportingFields(o);
  const reportingOriginalTotalDiscounts =
    rep.reporting_original_total_discounts ??
    (options?.reportingOriginalTotalDiscountsOverride != null &&
    Number.isFinite(options.reportingOriginalTotalDiscountsOverride)
      ? Math.round(options.reportingOriginalTotalDiscountsOverride * 100) / 100
      : null);
  const { data: existingOrder } = await supabase
    .from("shopify_orders")
    .select("id, reporting_total_refunded")
    .eq("shopify_order_id", shopifyOrderId)
    .maybeSingle();
  const money = mapShopifyOrderMoneyFields(o as unknown as ShopifyOrderPriceNode, {
    financialStatus: o.displayFinancialStatus as string | undefined,
    reportingTotalRefunded: rep.reporting_total_refunded,
    orderEdited: Boolean(o.edited),
  });
  const shipping = extractShippingFields(o);
  const fulfillmentRows = extractFulfillmentRows(o, null);
  const fulfillmentSummary = pickLatestTrackingSummary(fulfillmentRows);

  const { data: orderRows, error: orderErr } = await supabase
    .from("shopify_orders")
    .upsert(
      {
        shopify_order_id: shopifyOrderId,
        order_number: o.name as string | null,
        customer_id: customerUuid,
        shopify_customer_id: shopifyCustomerId,
        customer_name: cust.displayName || "Unknown",
        email: (o.email as string | null) || cust.defaultEmailAddress?.emailAddress || null,
        ...shipping,
        total: money.total,
        original_total: money.original_total,
        current_total: money.current_total,
        currency_code: (o.currencyCode as string | null) ||
          (o as { totalPriceSet?: { shopMoney?: { currencyCode?: string } } }).totalPriceSet?.shopMoney?.currencyCode ||
          null,
        subtotal: parseOrderSubtotalFromNode(o),
        total_tax: parseFloat(
          String((o as { currentTotalTaxSet?: { shopMoney?: { amount?: string } } }).currentTotalTaxSet?.shopMoney?.amount ||
            "0"),
        ) || null,
        financial_status: String(o.displayFinancialStatus || "PENDING").toLowerCase(),
        fulfillment_status: String(o.displayFulfillmentStatus || "UNFULFILLED").toLowerCase(),
        shopify_created_at: o.createdAt as string | null,
        processed_at: (o.processedAt as string | null) || null,
        order_note: (o.note as string | null) || null,
        tags: orderTags || null,
        test_order: Boolean(o.test),
        updated_at: new Date().toISOString(),
        reporting_line_items_gross: rep.reporting_line_items_gross,
        reporting_original_total_discounts: reportingOriginalTotalDiscounts,
        reporting_total_discounts: rep.reporting_total_discounts,
        reporting_total_shipping: rep.reporting_total_shipping,
        reporting_total_refunded: rep.reporting_total_refunded,
        taxes_included: rep.taxes_included,
        latest_tracking_number: fulfillmentSummary.latest_tracking_number,
        latest_tracking_url: fulfillmentSummary.latest_tracking_url,
        latest_tracking_company: fulfillmentSummary.latest_tracking_company,
        latest_tracking_status: fulfillmentSummary.latest_tracking_status,
        latest_fulfillment_updated_at: fulfillmentSummary.latest_fulfillment_updated_at,
      },
      { onConflict: "shopify_order_id" },
    )
    .select("id")
    .single();
  if (orderErr) throw orderErr;
  const orderId = orderRows?.id as string | undefined;
  if (!orderId) return null;

  await recordRefundDeltaIfIncreased(
    supabase,
    orderId,
    existingOrder?.reporting_total_refunded,
    rep.reporting_total_refunded,
  );

  const normalizedFulfillmentRows = dedupeFulfillmentRows(extractFulfillmentRows(o, orderId));
  const { error: delFulfillmentErr } = await supabase
    .from("shopify_order_fulfillments")
    .delete()
    .eq("order_id", orderId);
  if (delFulfillmentErr) throw delFulfillmentErr;
  if (normalizedFulfillmentRows.length > 0) {
    const { error: insFulfillmentErr } = await supabase
      .from("shopify_order_fulfillments")
      .insert(normalizedFulfillmentRows);
    if (insFulfillmentErr) throw insFulfillmentErr;
  }

  await supabase.from("shopify_order_items").delete().eq("order_id", orderId);
  const lineItems = mapGraphqlLineItemEdgesToRows(
    (o as { lineItems?: { edges?: { node: Record<string, unknown> }[] } }).lineItems?.edges,
    orderId,
  );
  if (lineItems.length > 0) {
    const { error: liErr } = await supabase.from("shopify_order_items").insert(lineItems);
    if (liErr) throw liErr;
  }

  if (customerUuid) {
    const { error: rfmErr } = await supabase.rpc("refresh_customer_rfm_metrics", { _customer_ids: [customerUuid] });
    if (rfmErr) console.error("refresh_customer_rfm_metrics order:", rfmErr.message, { customerId: customerUuid, orderId });
  }

  return { orderId, shopify_order_id: shopifyOrderId };
}
