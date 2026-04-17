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

type SalespersonRow = { user_id: string; salesperson_name: string | null };

async function addLeaderRecipientsFromSalespeople(
  supabase: ReturnType<typeof createClient>,
  salespersonIds: string[],
  recipientUserIds: Set<string>,
) {
  if (!salespersonIds.length) return;

  // Collect upward hierarchy (manager/supervisor) from assigned salespeople.
  // We walk two levels which covers salesperson -> manager -> supervisor and
  // also supports direct salesperson -> supervisor edges.
  let frontier = Array.from(new Set(salespersonIds));
  for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
    const { data: edges, error } = await supabase
      .from("sales_hierarchy_edges")
      .select("leader_user_id, member_user_id, leader_role")
      .in("member_user_id", frontier)
      .in("leader_role", ["manager", "supervisor"]);
    if (error) {
      console.error("sales_hierarchy_edges recipients lookup:", error.message);
      return;
    }
    const nextFrontier: string[] = [];
    for (const edge of edges || []) {
      const leaderId = (edge as { leader_user_id?: string | null }).leader_user_id;
      if (!leaderId) continue;
      recipientUserIds.add(leaderId);
      nextFrontier.push(leaderId);
    }
    frontier = Array.from(new Set(nextFrontier));
  }
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

async function assertDataPulseLicenseActive(
  supabase: ReturnType<typeof createClient>,
): Promise<void> {
  const { data: settings, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["datapulse_access_code", "datapulse_access_expires_at", "datapulse_license_mode", "datapulse_validation_url"]);
  if (error) throw new Error(`Failed to read license settings: ${error.message}`);

  const get = (key: string) => (settings || []).find((s: { key: string; value: string }) => s.key === key)?.value?.trim() || "";
  const code = get("datapulse_access_code").toUpperCase();
  const expiresAt = get("datapulse_access_expires_at");
  const mode = get("datapulse_license_mode");
  const validationUrl = get("datapulse_validation_url") || "https://clitxvzecgtdtracpbnt.supabase.co/functions/v1/validate-access-code";

  if (!code) throw new Error("Sync locked: missing DataPulse access code.");
  if (mode !== "lifetime") {
    const expiresMs = new Date(expiresAt).getTime();
    if (!expiresAt || Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
      throw new Error("Sync locked: DataPulse access code expired.");
    }
  }

  const res = await fetch(validationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const payload = await res.json().catch(() => ({} as { valid?: boolean; lifetime?: boolean; expires_at?: string; error?: string }));
  if (!res.ok || !payload?.valid) {
    throw new Error(payload?.error || "Sync locked: DataPulse code invalid.");
  }
  const isLifetime = payload?.lifetime === true || mode === "lifetime";
  if (!isLifetime && payload.expires_at && new Date(payload.expires_at).getTime() <= Date.now()) {
    throw new Error("Sync locked: DataPulse access code expired.");
  }
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
    await assertDataPulseLicenseActive(supabase);

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
            featuredImage {
              url
            }
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
      const featuredUrl = p.featuredImage?.url || null;
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
          featured_image_url: featuredUrl,
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

    const notifyUsersForNewOrder = async (internalOrderId: string) => {
      const { data: o } = await supabase
        .from("shopify_orders")
        .select("order_number, customer_name, total, currency_code, customer_id")
        .eq("id", internalOrderId)
        .maybeSingle();
      if (!o) return;
      const userIds = new Set<string>();
      const { data: admins } = await supabase.from("user_roles").select("user_id").eq("role", "admin");
      for (const r of admins || []) {
        const id = (r as { user_id: string }).user_id;
        if (id) userIds.add(id);
      }
      const assignedSalespersonIds = new Set<string>();
      if (o.customer_id) {
        const { data: assigns } = await supabase
          .from("salesperson_customer_assignments")
          .select("salesperson_user_id")
          .eq("customer_id", o.customer_id);
        for (const a of assigns || []) {
          const id = (a as { salesperson_user_id: string }).salesperson_user_id;
          if (!id) continue;
          userIds.add(id);
          assignedSalespersonIds.add(id);
        }
      }
      await addLeaderRecipientsFromSalespeople(supabase, Array.from(assignedSalespersonIds), userIds);
      const orderLabel = String(o.order_number || internalOrderId);
      const amt = Number(o.total || 0);
      const cur = o.currency_code || "";
      const body = `${orderLabel} · ${o.customer_name || "Customer"} · ${amt} ${cur}`.trim();
      for (const user_id of userIds) {
        const { error } = await supabase.from("user_notifications").insert({
          user_id,
          type: "new_order",
          title: "New order",
          body,
          entity_type: "order",
          entity_id: internalOrderId,
          payload: {
            order_number: orderLabel,
            total: amt,
            currency_code: o.currency_code,
          },
        });
        const code = (error as { code?: string } | null)?.code;
        if (error && code !== "23505") console.error("user_notifications order:", error.message);
      }
    };

    const notifyUsersForNewCustomer = async (internalCustomerId: string) => {
      const { data: c } = await supabase
        .from("shopify_customers")
        .select("name, email")
        .eq("id", internalCustomerId)
        .maybeSingle();
      if (!c) return;
      const userIds = new Set<string>();
      const { data: admins } = await supabase.from("user_roles").select("user_id").eq("role", "admin");
      for (const r of admins || []) {
        const id = (r as { user_id: string }).user_id;
        if (id) userIds.add(id);
      }
      const { data: assigns } = await supabase
        .from("salesperson_customer_assignments")
        .select("salesperson_user_id")
        .eq("customer_id", internalCustomerId);
      const assignedSalespersonIds = new Set<string>();
      for (const a of assigns || []) {
        const id = (a as { salesperson_user_id: string }).salesperson_user_id;
        if (!id) continue;
        userIds.add(id);
        assignedSalespersonIds.add(id);
      }
      await addLeaderRecipientsFromSalespeople(supabase, Array.from(assignedSalespersonIds), userIds);
      const body = `${c.name}${c.email ? ` · ${c.email}` : ""}`.trim();
      for (const user_id of userIds) {
        const { error } = await supabase.from("user_notifications").insert({
          user_id,
          type: "new_customer",
          title: "New customer",
          body,
          entity_type: "customer",
          entity_id: internalCustomerId,
          payload: { name: c.name, email: c.email },
        });
        const code = (error as { code?: string } | null)?.code;
        if (error && code !== "23505") console.error("user_notifications customer:", error.message);
      }
    };

    try {
      if (topic === "customers/create" || topic === "customers/update") {
        const customerGid = String(payload.admin_graphql_api_id || "");
        if (customerGid) {
          const customerId = await upsertCustomerByGid(customerGid);
          if (topic === "customers/create" && customerId) {
            await notifyUsersForNewCustomer(customerId);
          }
        } else await markDone("ignored", "customer webhook missing admin_graphql_api_id");
      } else if (topic === "orders/create" || topic === "orders/updated") {
        const orderGid = String(payload.admin_graphql_api_id || "");
        if (orderGid) {
          const orderId = await upsertOrderByGid(orderGid);
          if (topic === "orders/create" && orderId) {
            await notifyUsersForNewOrder(orderId);
          }
        } else await markDone("ignored", "order webhook missing admin_graphql_api_id");
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
