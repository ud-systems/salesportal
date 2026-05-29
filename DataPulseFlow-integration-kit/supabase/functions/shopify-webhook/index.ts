import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders } from "../_shared/cors.ts";
import {
  looksLikeShopifyCustomAppAdminToken,
  normalizeShopifyDomain,
  SHOPIFY_ADMIN_API_VERSION,
} from "../_shared/shopify-credentials.ts";
import { resolveShopifyAuth } from "../_shared/shopify-auth.ts";
import {
  findSalespersonRow,
  isShopifyNoReferralChoice,
  labelsMatchShopifyToRole,
  metafieldValueForKeysOrdered,
  normalizeSalespersonLabel,
  REFERRED_BY_METAFIELD_KEYS_ORDERED,
  SP_ASSIGNED_METAFIELD_KEYS_ORDERED,
  stripReferralPrefix,
} from "../_shared/salesperson-match.ts";
import { SHOPIFY_ORDER_DETAIL_GQL, upsertShopifyOrderFromGraphqlNode } from "../_shared/shopify-order-graphql-upsert.ts";

type SalespersonRow = { user_id: string; salesperson_name: string | null };

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
  const payloads: { customer_id: string; salesperson_user_id: string; source: string }[] = [];
  for (const sp of salespeople) {
    const nm = normalizeSalespersonLabel(sp.salesperson_name);
    if (!nm) continue;
    if (
      assignedNorm &&
      assignedNorm !== "unassigned" &&
      labelsMatchShopifyToRole(spAssignedDisplay, sp.salesperson_name)
    ) {
      payloads.push({ customer_id: customerUuid, salesperson_user_id: sp.user_id, source: "sp_assigned" });
    } else if (
      referredByDisplay?.trim() &&
      !isShopifyNoReferralChoice(referredByDisplay) &&
      labelsMatchShopifyToRole(referredByDisplay, sp.salesperson_name)
    ) {
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
            metafields(first: 80) { edges { node { namespace key value } } }
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
      const metafields = (c.metafields?.edges || []).map(
        (e: { node: { namespace?: string; key: string; value: string } }) => e.node,
      );
      let spAssigned =
        metafieldValueForKeysOrdered(metafields, SP_ASSIGNED_METAFIELD_KEYS_ORDERED) || "Unassigned";
      let referredBy = metafieldValueForKeysOrdered(metafields, REFERRED_BY_METAFIELD_KEYS_ORDERED);
      if (referredBy) {
        const stripped = stripReferralPrefix(referredBy).trim();
        referredBy = stripped || null;
      }
      if (referredBy && isShopifyNoReferralChoice(referredBy)) {
        referredBy = null;
      }

      // If Shopify doesn't provide SP_Assigned, infer from `referred_by` to keep UI consistent.
      if (!spAssigned || spAssigned.trim().toLowerCase() === "unassigned") {
        const hit = findSalespersonRow(salespeople, referredBy);
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
      const { data } = await buildShopifyQuery(shopDomain, adminToken, SHOPIFY_ORDER_DETAIL_GQL, { id: orderGid });
      const resolveCustomer = async (customerGid: string | null) => {
        if (!customerGid) return null;
        const shopifyCustomerNumeric = customerGid.replace("gid://shopify/Customer/", "");
        const { data: customerRow } = await supabase
          .from("shopify_customers")
          .select("id")
          .eq("shopify_customer_id", shopifyCustomerNumeric)
          .maybeSingle();
        if (customerRow?.id) return customerRow.id;
        return await upsertCustomerByGid(customerGid);
      };
      const row = await upsertShopifyOrderFromGraphqlNode(
        supabase,
        data?.order as Record<string, unknown> | undefined,
        resolveCustomer,
      );
      return row?.orderId ?? null;
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
