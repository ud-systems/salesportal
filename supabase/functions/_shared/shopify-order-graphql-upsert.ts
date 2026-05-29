import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { mapShopifyOrderMoneyFields, type ShopifyOrderPriceNode } from "./shopify-order-totals.ts";
import { extractOrderReportingFields } from "./shopify-order-reporting.ts";

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
    taxesIncluded
    subtotalPriceSet { shopMoney { amount } }
    currentTotalTaxSet { shopMoney { amount } }
    totalPriceSet { shopMoney { amount currencyCode } }
    originalTotalPriceSet { shopMoney { amount } }
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    currentTotalDiscountsSet { shopMoney { amount } }
    currentShippingPriceSet { shopMoney { amount } }
    totalRefundedSet { shopMoney { amount } }
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

/**
 * Upserts shopify_orders + shopify_order_items from a GraphQL `order` node.
 * Caller supplies how to resolve internal customer UUID (full customer sync vs lookup-only).
 */
export async function upsertShopifyOrderFromGraphqlNode(
  supabase: SupabaseClient,
  orderNode: Record<string, unknown> | null | undefined,
  resolveCustomerUuid: OrderCustomerResolver,
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
  const money = mapShopifyOrderMoneyFields(o as unknown as ShopifyOrderPriceNode);
  const rep = extractOrderReportingFields(o);
  const shipping = extractShippingFields(o);

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
        subtotal: parseFloat(
          String((o as { subtotalPriceSet?: { shopMoney?: { amount?: string } } }).subtotalPriceSet?.shopMoney?.amount ||
            "0"),
        ) || null,
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
        reporting_total_discounts: rep.reporting_total_discounts,
        reporting_total_shipping: rep.reporting_total_shipping,
        reporting_total_refunded: rep.reporting_total_refunded,
        taxes_included: rep.taxes_included,
      },
      { onConflict: "shopify_order_id" },
    )
    .select("id")
    .single();
  if (orderErr) throw orderErr;
  const orderId = orderRows?.id as string | undefined;
  if (!orderId) return null;

  await supabase.from("shopify_order_items").delete().eq("order_id", orderId);
  const lineItems = ((o as { lineItems?: { edges?: { node: Record<string, unknown> }[] } }).lineItems?.edges || []).map(
    (e: { node: Record<string, unknown> }) => {
      const n = e.node as {
        id?: string;
        title?: string;
        variantTitle?: string;
        quantity?: number;
        sku?: string | null;
        variant?: { id?: string; sku?: string | null } | null;
        originalUnitPriceSet?: { shopMoney?: { amount?: string } };
      };
      return {
        order_id: orderId,
        shopify_line_item_id: n.id ? String(n.id).replace("gid://shopify/LineItem/", "") : null,
        shopify_variant_gid: n.variant?.id || null,
        product: n.title || null,
        variant: n.variantTitle || "Default",
        sku: n.variant?.sku || n.sku || null,
        quantity: n.quantity || 0,
        price: parseFloat(n.originalUnitPriceSet?.shopMoney?.amount || "0"),
      };
    },
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
