import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders } from "../_shared/cors.ts";
import {
  looksLikeShopifyCustomAppAdminToken,
  normalizeShopifyDomain,
  SHOPIFY_ADMIN_API_VERSION,
} from "../_shared/shopify-credentials.ts";
import { resolveShopifyAuth } from "../_shared/shopify-auth.ts";

type SalespersonRow = { user_id: string; salesperson_name: string | null };

function normalizeSalespersonLabel(s: string | null | undefined): string {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function metafieldByKeys(
  metafields: { key: string; value: string }[],
  keys: string[],
): string | null {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  const hit = metafields.find((m) => want.has(m.key.toLowerCase()));
  return hit?.value ?? null;
}

function b64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function verifyShopifyHmac(raw: string, secret: string, receivedHmac: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const expected = b64FromBytes(new Uint8Array(sig));
  return timingSafeEqual(expected, receivedHmac.trim());
}

async function upsertSalespersonAssignments(
  supabase: ReturnType<typeof createClient>,
  customerUuid: string,
  spAssignedDisplay: string,
  referredByDisplay: string | null,
  salespeople: SalespersonRow[],
) {
  const assignedNorm = normalizeSalespersonLabel(spAssignedDisplay);
  const refNorm = referredByDisplay ? normalizeSalespersonLabel(referredByDisplay) : "";
  const payloads: { customer_id: string; salesperson_user_id: string; source: string }[] = [];
  for (const sp of salespeople) {
    const nm = normalizeSalespersonLabel(sp.salesperson_name);
    if (!nm) continue;
    if (assignedNorm && assignedNorm !== "unassigned" && assignedNorm === nm) {
      payloads.push({ customer_id: customerUuid, salesperson_user_id: sp.user_id, source: "sp_assigned" });
    } else if (refNorm && refNorm === nm) {
      payloads.push({ customer_id: customerUuid, salesperson_user_id: sp.user_id, source: "referred_by" });
    }
  }
  const seen = new Set<string>();
  for (const row of payloads) {
    if (seen.has(row.salesperson_user_id)) continue;
    seen.add(row.salesperson_user_id);
    await supabase.from("salesperson_customer_assignments").upsert(row, {
      onConflict: "customer_id,salesperson_user_id",
    });
  }
}

async function buildShopifyQuery(
  shopDomain: string,
  adminToken: string,
  query: string,
  variables: Record<string, unknown> = {},
) {
  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  const json = JSON.parse(text);
  if (!res.ok) throw new Error(`Shopify API error [${res.status}]: ${text}`);
  if (json.errors?.length) throw new Error(`Shopify GraphQL: ${json.errors.map((e: { message?: string }) => e.message).join("; ")}`);
  return json;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Config from settings/env
    const { data: settings } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["shopify_webhook_secret"]);

    const auth = await resolveShopifyAuth(supabase);
    let shopDomain = auth.shopDomain;
    let adminToken = auth.accessToken;
    let webhookSecret = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") || "";
    for (const s of settings || []) {
      if (s.key === "shopify_webhook_secret") webhookSecret = s.value || webhookSecret;
    }
    shopDomain = normalizeShopifyDomain(shopDomain);
    webhookSecret = webhookSecret.trim();

    if (!shopDomain || !adminToken || !webhookSecret) {
      return new Response(JSON.stringify({ error: "Webhook not configured. Set store domain, Admin API token, and webhook secret." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!looksLikeShopifyCustomAppAdminToken(adminToken)) {
      return new Response(JSON.stringify({ error: "Invalid Shopify Admin API token format." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const topic = (req.headers.get("x-shopify-topic") || "").trim().toLowerCase();
    const webhookId = (req.headers.get("x-shopify-webhook-id") || crypto.randomUUID()).trim();
    const sourceShop = normalizeShopifyDomain(req.headers.get("x-shopify-shop-domain") || "");
    const hmac = req.headers.get("x-shopify-hmac-sha256") || "";

    if (!topic || !hmac || !sourceShop) {
      return new Response(JSON.stringify({ error: "Missing Shopify webhook headers." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (sourceShop !== shopDomain) {
      return new Response(JSON.stringify({ error: "Shop domain mismatch." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rawBody = await req.text();
    const verified = await verifyShopifyHmac(rawBody, webhookSecret, hmac);
    if (!verified) {
      return new Response(JSON.stringify({ error: "Invalid webhook HMAC signature." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = JSON.parse(rawBody || "{}") as Record<string, unknown>;

    // Idempotency
    const { error: insertErr } = await supabase
      .from("shopify_webhook_events")
      .insert({ webhook_id: webhookId, topic, shop_domain: sourceShop, payload, status: "processing" });
    if (insertErr) {
      if ((insertErr as { code?: string }).code === "23505") {
        return new Response(JSON.stringify({ success: true, duplicate: true }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw insertErr;
    }

    const { data: salespeopleRows } = await supabase
      .from("user_roles")
      .select("user_id, salesperson_name")
      .eq("role", "salesperson");
    const salespeople: SalespersonRow[] = (salespeopleRows || []) as SalespersonRow[];

    const markDone = async (status: "success" | "ignored" | "error", errorMessage?: string) => {
      await supabase
        .from("shopify_webhook_events")
        .update({
          status,
          error_message: errorMessage || null,
          processed_at: new Date().toISOString(),
        })
        .eq("webhook_id", webhookId);
    };

    const upsertCustomerByGid = async (customerGid: string) => {
      const { data } = await buildShopifyQuery(
        shopDomain,
        adminToken,
        `query($id: ID!) {
          customer(id: $id) {
            id
            displayName
            firstName
            lastName
            defaultEmailAddress { emailAddress }
            defaultPhoneNumber { phoneNumber }
            defaultAddress {
              address1
              address2
              city
              provinceCode
              countryCodeV2
              zip
            }
            metafields(first: 50) { edges { node { key value } } }
            numberOfOrders
            amountSpent { amount currencyCode }
            createdAt
            note
            locale
            state
          }
        }`,
        { id: customerGid },
      );
      const c = data?.customer;
      if (!c?.id) return null;
      const shopifyId = String(c.id).replace("gid://shopify/Customer/", "");
      const metafields = (c.metafields?.edges || []).map((e: { node: { key: string; value: string } }) => e.node);
      const spAssigned =
        metafieldByKeys(metafields, ["SP_Assigned", "sp_assigned", "sp_assigned_customer", "Salesperson", "salesperson"]) ||
        "Unassigned";
      const referredBy = metafieldByKeys(metafields, ["Referredby", "referredby", "referred_by", "referredBy", "Referrer", "referrer"]);

      // If Shopify doesn't provide SP_Assigned, infer from `referred_by` to keep UI consistent.
      if (!spAssigned || spAssigned.trim().toLowerCase() === "unassigned") {
        const refNorm = normalizeSalespersonLabel(referredBy || "");
        const hit = salespeople.find((sp) => normalizeSalespersonLabel(sp.salesperson_name) === refNorm);
        if (hit?.salesperson_name) spAssigned = hit.salesperson_name;
      }
      const addr = c.defaultAddress;
      await supabase.from("shopify_customers").upsert({
        shopify_customer_id: shopifyId,
        name: c.displayName || "Unknown",
        first_name: c.firstName || null,
        last_name: c.lastName || null,
        email: c.defaultEmailAddress?.emailAddress ?? null,
        phone: c.defaultPhoneNumber?.phoneNumber ?? null,
        city: addr?.city || null,
        address1: addr?.address1 || null,
        address2: addr?.address2 || null,
        province: addr?.provinceCode || null,
        country: addr?.countryCodeV2 || null,
        zip: addr?.zip || null,
        sp_assigned: spAssigned,
        referred_by: referredBy,
        total_orders: Number(c.numberOfOrders ?? 0),
        total_revenue: parseFloat(c.amountSpent?.amount || "0"),
        spend_currency: c.amountSpent?.currencyCode || null,
        shopify_created_at: c.createdAt,
        customer_note: c.note || null,
        locale: c.locale || null,
        account_state: c.state || null,
      }, { onConflict: "shopify_customer_id" });

      const { data: row } = await supabase.from("shopify_customers").select("id").eq("shopify_customer_id", shopifyId).maybeSingle();
      if (row?.id) await upsertSalespersonAssignments(supabase, row.id, spAssigned, referredBy, salespeople);
      return row?.id || null;
    };

    const upsertOrderByGid = async (orderGid: string) => {
      const { data } = await buildShopifyQuery(
        shopDomain,
        adminToken,
        `query($id: ID!) {
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
            subtotalPriceSet { shopMoney { amount } }
            currentTotalTaxSet { shopMoney { amount } }
            totalPriceSet { shopMoney { amount currencyCode } }
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
        }`,
        { id: orderGid },
      );
      const o = data?.order;
      if (!o?.id) return null;
      const shopifyOrderId = String(o.id).replace("gid://shopify/Order/", "");
      const shopifyCustomerId = o.customer?.id ? String(o.customer.id).replace("gid://shopify/Customer/", "") : null;
      let customerUuid: string | null = null;
      if (shopifyCustomerId) {
        const { data: customerRow } = await supabase
          .from("shopify_customers")
          .select("id")
          .eq("shopify_customer_id", shopifyCustomerId)
          .maybeSingle();
        customerUuid = customerRow?.id || null;
        if (!customerUuid && o.customer?.id) {
          customerUuid = await upsertCustomerByGid(String(o.customer.id));
        }
      }
      const orderTags = Array.isArray(o.tags) ? o.tags.join(", ") : "";
      const { data: orderRows, error: orderErr } = await supabase
        .from("shopify_orders")
        .upsert({
          shopify_order_id: shopifyOrderId,
          order_number: o.name,
          customer_id: customerUuid,
          shopify_customer_id: shopifyCustomerId,
          customer_name: o.customer?.displayName || "Unknown",
          email: o.email || o.customer?.defaultEmailAddress?.emailAddress || null,
          total: parseFloat(o.totalPriceSet?.shopMoney?.amount || "0"),
          currency_code: o.currencyCode || o.totalPriceSet?.shopMoney?.currencyCode || null,
          subtotal: parseFloat(o.subtotalPriceSet?.shopMoney?.amount || "0") || null,
          total_tax: parseFloat(o.currentTotalTaxSet?.shopMoney?.amount || "0") || null,
          financial_status: String(o.displayFinancialStatus || "PENDING").toLowerCase(),
          fulfillment_status: String(o.displayFulfillmentStatus || "UNFULFILLED").toLowerCase(),
          shopify_created_at: o.createdAt,
          processed_at: o.processedAt || null,
          order_note: o.note || null,
          tags: orderTags || null,
          test_order: Boolean(o.test),
        }, { onConflict: "shopify_order_id" })
        .select("id")
        .single();
      if (orderErr) throw orderErr;
      const orderId = orderRows?.id;
      if (!orderId) return null;

      await supabase.from("shopify_order_items").delete().eq("order_id", orderId);
      const lineItems = (o.lineItems?.edges || []).map((e: { node: Record<string, unknown> }) => {
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
      });
      if (lineItems.length > 0) await supabase.from("shopify_order_items").insert(lineItems);
      return orderId;
    };

    const upsertProductByGid = async (productGid: string) => {
      const { data } = await buildShopifyQuery(
        shopDomain,
        adminToken,
        `query($id: ID!) {
          product(id: $id) {
            id
            title
            handle
            status
            descriptionHtml
            tags
            vendor
            productType
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                }
              }
            }
          }
        }`,
        { id: productGid },
      );
      const p = data?.product;
      if (!p?.id) return null;
      const shopifyProductId = String(p.id).replace("gid://shopify/Product/", "");
      const productTags = Array.isArray(p.tags) ? p.tags.join(", ") : "";
      const { data: productRow, error: prodErr } = await supabase
        .from("shopify_products")
        .upsert({
          shopify_product_id: shopifyProductId,
          title: p.title,
          vendor: p.vendor,
          category: p.productType || null,
          handle: p.handle || null,
          status: p.status || null,
          description_html: p.descriptionHtml || null,
          tags: productTags || null,
        }, { onConflict: "shopify_product_id" })
        .select("id")
        .single();
      if (prodErr) throw prodErr;
      const productId = productRow?.id;
      if (!productId) return null;

      const variantIds = (p.variants?.edges || [])
        .map((e: { node: { id: string } }) => e.node?.id?.replace("gid://shopify/ProductVariant/", ""))
        .filter(Boolean);
      if (variantIds.length > 0) {
        await supabase.from("shopify_variants").delete().eq("product_id", productId).in("shopify_variant_id", variantIds);
      }
      for (const edge of p.variants?.edges || []) {
        const v = edge.node;
        await supabase.from("shopify_variants").upsert({
          shopify_variant_id: String(v.id).replace("gid://shopify/ProductVariant/", ""),
          product_id: productId,
          title: v.title || null,
          sku: v.sku || null,
          price: parseFloat(v.price || "0"),
          stock: Number(v.inventoryQuantity || 0),
          inventory_location: null,
        }, { onConflict: "shopify_variant_id" });
      }
      return productId;
    };

    try {
      if (topic === "customers/create" || topic === "customers/update") {
        const customerGid = String(payload.admin_graphql_api_id || "");
        if (customerGid) await upsertCustomerByGid(customerGid);
        else await markDone("ignored", "customer webhook missing admin_graphql_api_id");
      } else if (topic === "orders/create" || topic === "orders/updated") {
        const orderGid = String(payload.admin_graphql_api_id || "");
        if (orderGid) await upsertOrderByGid(orderGid);
        else await markDone("ignored", "order webhook missing admin_graphql_api_id");
      } else if (topic === "products/create" || topic === "products/update") {
        const productGid = String(payload.admin_graphql_api_id || "");
        if (productGid) await upsertProductByGid(productGid);
        else await markDone("ignored", "product webhook missing admin_graphql_api_id");
      } else {
        await markDone("ignored", `topic not handled: ${topic}`);
      }
      await markDone("success");
      return new Response(JSON.stringify({ success: true, topic }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (handlerErr) {
      const msg = handlerErr instanceof Error ? handlerErr.message : "Unknown handler error";
      await markDone("error", msg);
      throw handlerErr;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    console.error("shopify-webhook error:", err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
