import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/require-admin.ts";
import {
  looksLikeShopifyCustomAppAdminToken,
  SHOPIFY_ADMIN_API_VERSION,
} from "../_shared/shopify-credentials.ts";
import { resolveShopifyAuth } from "../_shared/shopify-auth.ts";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function isAuthorizedInternalCron(req: Request): boolean {
  const expected = (Deno.env.get("SHOPIFY_CRON_SECRET") || "").trim();
  if (!expected) return false;
  const provided = (req.headers.get("x-shopify-cron-secret") || "").trim();
  if (!provided) return false;
  return timingSafeEqual(expected, provided);
}

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

type SalespersonRow = { user_id: string; salesperson_name: string | null };

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
    const { error } = await supabase.from("salesperson_customer_assignments").upsert(row, {
      onConflict: "customer_id,salesperson_user_id",
    });
    if (error) console.error("salesperson_customer_assignments upsert:", error.message, row);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
  const isCronCall = isAuthorizedInternalCron(req);
  if (!isCronCall) {
    const denied = await requireAdmin(req, corsHeaders);
    if (denied) return denied;
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const auth = await resolveShopifyAuth(serviceClient);
  let SHOPIFY_STORE_DOMAIN = auth.shopDomain;
  let SHOPIFY_ACCESS_TOKEN = auth.accessToken;

  if (SHOPIFY_ACCESS_TOKEN && !looksLikeShopifyCustomAppAdminToken(SHOPIFY_ACCESS_TOKEN)) {
    return new Response(
      JSON.stringify({
        error:
          "Shopify Admin API token must be a Custom app access token (shpat_…). Update Settings → save the correct Admin API access token from this store’s Develop apps → API credentials.",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!SHOPIFY_STORE_DOMAIN) {
    return new Response(JSON.stringify({ error: "SHOPIFY_STORE_DOMAIN not configured. Go to Settings to configure." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!SHOPIFY_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ error: "SHOPIFY_ACCESS_TOKEN not configured. Go to Settings to configure." }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const requestBody = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const requestedModule = typeof requestBody?.module === "string" ? requestBody.module : null;
  const allowedModules = new Set(["customers", "orders", "products", "collections", "purchase_orders"]);
  if (requestedModule && !allowedModules.has(requestedModule)) {
    return new Response(JSON.stringify({ error: `Invalid module "${requestedModule}"` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const shouldRun = (module: string) => !requestedModule || requestedModule === module;
  const SHOPIFY_API = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;

  const shopifyQuery = async (query: string, variables: Record<string, unknown> = {}) => {
    const res = await fetch(SHOPIFY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify API error [${res.status}]: ${text}`);
    }
    const json = await res.json();
    // Shopify returns HTTP 200 with { errors: [...] } for GraphQL failures — must surface these.
    if (json.errors?.length) {
      const msg = json.errors.map((e: { message?: string }) => e.message).join("; ");
      throw new Error(`Shopify GraphQL: ${msg}`);
    }
    return json;
  };

  /** Live progress in sync_logs while status=running (fixes “0 records” when run ends early). */
  const flushRunningLog = async (logId: string | null, count: number) => {
    if (!logId) return;
    const { error } = await supabase
      .from("sync_logs")
      .update({ records_synced: count })
      .eq("id", logId)
      .eq("status", "running");
    if (error) console.error("sync_logs progress update failed:", error.message, { logId, count });
  };

  /** Mark abandoned "running" rows so UI does not spin forever after timeouts/crashes */
  const staleBefore = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  await supabase
    .from("sync_logs")
    .update({
      status: "error",
      error_message: "Interrupted (previous run timed out or crashed — run sync again)",
      completed_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("started_at", staleBefore);

  const results: Record<string, { synced: number; status: string; error?: string; note?: string }> = {};
  const startedAtMs = Date.now();
  const SOFT_TIMEOUT_MS = Number(Deno.env.get("SHOPIFY_SYNC_SOFT_TIMEOUT_MS") ?? "110000");
  const hitSoftTimeout = () => Date.now() - startedAtMs >= SOFT_TIMEOUT_MS;
  const softTimeoutNote = "Stopped early to avoid runtime timeout. Run sync again to continue.";
  let checkpointUnavailable = false;
  const checkpointNote = "Checkpoint table unavailable; run sync_checkpoints migration so runs resume instead of restarting.";
  const finalizeSuccessLog = async (logId: string | null, count: number, note?: string) => {
    if (!logId) return;
    await supabase.from("sync_logs").update({
      status: "success",
      records_synced: count,
      error_message: note || null,
      completed_at: new Date().toISOString(),
    }).eq("id", logId);
  };
  const getCheckpoint = async (syncType: string) => {
    const { data, error } = await supabase
      .from("sync_checkpoints")
      .select("cursor, last_completed_at")
      .eq("sync_type", syncType)
      .maybeSingle();
    if (error) {
      checkpointUnavailable = true;
      console.error("sync_checkpoints read failed:", error.message, { syncType });
    }
    return {
      cursor: data?.cursor || null,
      lastCompletedAt: data?.last_completed_at || null,
    };
  };
  const saveCheckpointCursor = async (syncType: string, cursor: string | null, completed = false) => {
    const payload: Record<string, unknown> = {
      sync_type: syncType,
      cursor: completed ? null : cursor,
      updated_at: new Date().toISOString(),
    };
    if (completed) payload.last_completed_at = new Date().toISOString();
    const { error } = await supabase.from("sync_checkpoints").upsert(payload, { onConflict: "sync_type" });
    if (error) {
      checkpointUnavailable = true;
      console.error("sync_checkpoints upsert failed:", error.message, { syncType, cursor, completed });
    }
  };
  const isInvalidCursorError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err || "");
    return /Invalid cursor for current pagination sort/i.test(msg);
  };

  /** Shopify lists use sortKey UPDATED_AT reverse:true → newest changes first. Per page/batch we upsert new rows before updates where applicable. */
  const SYNC_POLICY_NOTE =
    "Policy: newest-first from Shopify (UPDATED_AT desc); customers, orders, collections, and PO batches write new rows before updates; products stay per-product (variants need parent row id).";

  // --- SYNC CUSTOMERS ---
  if (shouldRun("customers")) {
  let customersLogId: string | null = null;
  let customersPartialCount = 0;
  try {
    customersLogId = crypto.randomUUID();
    await supabase.from("sync_logs").insert({ id: customersLogId, sync_type: "customers", status: "running" });

    let hasNextPage = true;
    const customerCheckpoint = await getCheckpoint("customers");
    let cursor: string | null = customerCheckpoint.cursor;
    const customerCutoffMs = customerCheckpoint.lastCompletedAt
      ? new Date(customerCheckpoint.lastCompletedAt).getTime() - 5 * 60 * 1000
      : null;
    let customerReachedCutoff = false;
    let totalSynced = 0;
    let customerPages = 0;
    const MAX_CUSTOMER_PAGES = Number(Deno.env.get("SHOPIFY_MAX_CUSTOMER_PAGES_PER_RUN") ?? "25");

    const { data: salespeopleRows } = await supabase
      .from("user_roles")
      .select("user_id, salesperson_name")
      .eq("role", "salesperson");
    const salespeople: SalespersonRow[] = (salespeopleRows || []) as SalespersonRow[];

    while (hasNextPage && customerPages < MAX_CUSTOMER_PAGES && !hitSoftTimeout()) {
      customerPages++;
      const afterClause = cursor ? `, after: "${cursor}"` : "";
      let data: any;
      try {
        ({ data } = await shopifyQuery(`{
        customers(first: 50${afterClause}, sortKey: UPDATED_AT, reverse: true) {
          edges {
            cursor
            node {
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
              metafields(first: 50) {
                edges {
                  node {
                    namespace
                    key
                    value
                  }
                }
              }
              numberOfOrders
              amountSpent { amount currencyCode }
              createdAt
              updatedAt
              note
              locale
              state
            }
          }
          pageInfo { hasNextPage }
        }
      }`));
      } catch (err) {
        if (cursor && isInvalidCursorError(err)) {
          console.warn("Invalid Shopify cursor for customers; resetting checkpoint cursor and retrying from latest.");
          cursor = null;
          await saveCheckpointCursor("customers", null, false);
          customerPages--;
          continue;
        }
        throw err;
      }

      const edges = data?.customers?.edges || [];
      hasNextPage = data?.customers?.pageInfo?.hasNextPage || false;

      const pageCustomerIds = edges
        .map((edge: { node?: { id?: string } }) => edge?.node?.id?.replace("gid://shopify/Customer/", ""))
        .filter(Boolean) as string[];
      const existingCustomerIds = new Set<string>();
      if (pageCustomerIds.length > 0) {
        const { data: existingCustRows, error: existingCustErr } = await supabase
          .from("shopify_customers")
          .select("shopify_customer_id")
          .in("shopify_customer_id", pageCustomerIds);
        if (existingCustErr) throw existingCustErr;
        for (const row of existingCustRows || []) {
          if ((row as { shopify_customer_id?: string }).shopify_customer_id) {
            existingCustomerIds.add((row as { shopify_customer_id: string }).shopify_customer_id);
          }
        }
      }
      const newCustomerPayloads: Array<Record<string, unknown>> = [];
      const updateCustomerPayloads: Array<Record<string, unknown>> = [];

      for (const edge of edges) {
        if (hitSoftTimeout()) {
          hasNextPage = true;
          break;
        }
        cursor = edge.cursor;
        const c = edge.node;
        if (customerCutoffMs && c.updatedAt && new Date(c.updatedAt).getTime() <= customerCutoffMs) {
          customerReachedCutoff = true;
          hasNextPage = false;
          break;
        }
        const shopifyId = c.id.replace("gid://shopify/Customer/", "");
        const metafields = c.metafields?.edges?.map((e: { node: { namespace: string; key: string; value: string } }) => e.node) || [];
        let spAssigned =
          metafieldByKeys(metafields, ["SP_Assigned", "sp_assigned", "sp_assigned_customer", "Salesperson", "salesperson"]) ||
          "Unassigned";
        const referredBy = metafieldByKeys(metafields, [
          "Referredby",
          "referredby",
          "referred_by",
          "Referred_By",
          "referredBy",
          "Referrer",
          "referrer",
        ]);

        // If Shopify doesn't set SP_Assigned (or sets "Unassigned"), infer it from `referred_by`
        // so UI assignment status stays correct.
        if (!spAssigned || spAssigned.trim().toLowerCase() === "unassigned") {
          const refNorm = normalizeSalespersonLabel(referredBy || "");
          const hit = salespeople.find((sp) => normalizeSalespersonLabel(sp.salesperson_name) === refNorm);
          if (hit?.salesperson_name) spAssigned = hit.salesperson_name;
        }

        const addr = c.defaultAddress;
        const totalRevenue = parseFloat(c.amountSpent?.amount || "0");
        const ordersCount = Number(c.numberOfOrders ?? 0);
        const row = {
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
          total_orders: ordersCount,
          total_revenue: totalRevenue,
          spend_currency: c.amountSpent?.currencyCode || null,
          shopify_created_at: c.createdAt,
          customer_note: c.note || null,
          locale: c.locale || null,
          account_state: c.state || null,
        };
        const isNew = !existingCustomerIds.has(shopifyId);
        if (isNew) {
          existingCustomerIds.add(shopifyId);
          newCustomerPayloads.push(row);
        } else {
          updateCustomerPayloads.push(row);
        }
      }
      if (newCustomerPayloads.length > 0) {
        const { error: custNewErr } = await supabase
          .from("shopify_customers")
          .upsert(newCustomerPayloads, { onConflict: "shopify_customer_id" });
        if (custNewErr) throw custNewErr;
        totalSynced += newCustomerPayloads.length;
      }
      if (updateCustomerPayloads.length > 0) {
        const { error: custUpdErr } = await supabase
          .from("shopify_customers")
          .upsert(updateCustomerPayloads, { onConflict: "shopify_customer_id" });
        if (custUpdErr) throw custUpdErr;
        totalSynced += updateCustomerPayloads.length;
      }
      const touchedShopifyIds = [
        ...newCustomerPayloads.map((r) => String((r as { shopify_customer_id: string }).shopify_customer_id)),
        ...updateCustomerPayloads.map((r) => String((r as { shopify_customer_id: string }).shopify_customer_id)),
      ];
      if (touchedShopifyIds.length > 0 && salespeople.length > 0) {
        const { data: custLinks, error: custLinkErr } = await supabase
          .from("shopify_customers")
          .select("id, sp_assigned, referred_by")
          .in("shopify_customer_id", touchedShopifyIds);
        if (custLinkErr) throw custLinkErr;
        for (const link of custLinks || []) {
          const row = link as { id: string; sp_assigned: string | null; referred_by: string | null };
          await upsertSalespersonAssignments(
            supabase,
            row.id,
            row.sp_assigned || "Unassigned",
            row.referred_by,
            salespeople,
          );
        }
      }
      customersPartialCount = totalSynced;
      await flushRunningLog(customersLogId, totalSynced);
      await saveCheckpointCursor("customers", cursor, !hasNextPage || customerReachedCutoff);
    }

    const customerNote = [
      SYNC_POLICY_NOTE,
      hitSoftTimeout()
        ? softTimeoutNote
        : hasNextPage
          ? `Stopped at ${MAX_CUSTOMER_PAGES} pages; run sync again for more customers.`
          : totalSynced === 0
            ? "Already up to date (no new customer changes)."
            : undefined,
      checkpointUnavailable ? checkpointNote : undefined,
    ].filter(Boolean).join(" ");
    await finalizeSuccessLog(customersLogId, totalSynced, customerNote);
    customersPartialCount = totalSynced;

    results.customers = {
      synced: totalSynced,
      status: "success",
      ...(customerNote ? { note: customerNote } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    results.customers = { synced: 0, status: "error", error: msg };
    if (customersLogId) {
      await supabase.from("sync_logs").update({
        status: "error",
        error_message: msg,
        records_synced: customersPartialCount,
        completed_at: new Date().toISOString(),
      }).eq("id", customersLogId);
    }
  }
  }

  // --- SYNC ORDERS ---
  if (shouldRun("orders")) {
  let ordersLogId: string | null = null;
  let ordersPartialCount = 0;
  try {
    ordersLogId = crypto.randomUUID();
    await supabase.from("sync_logs").insert({ id: ordersLogId, sync_type: "orders", status: "running" });

    const { data: customerRows } = await supabase.from("shopify_customers").select("id, shopify_customer_id");
    const customerIdByShopify = new Map(
      (customerRows || []).map((r: { id: string; shopify_customer_id: string }) => [r.shopify_customer_id, r.id]),
    );

    let hasNextPage = true;
    const orderCheckpoint = await getCheckpoint("orders");
    let cursor: string | null = orderCheckpoint.cursor;
    const orderCutoffMs = orderCheckpoint.lastCompletedAt
      ? new Date(orderCheckpoint.lastCompletedAt).getTime() - 5 * 60 * 1000
      : null;
    let orderReachedCutoff = false;
    let totalSynced = 0;
    let insertedOrders = 0;
    let updatedOrders = 0;
    let orderPages = 0;
    const MAX_ORDER_PAGES = Number(Deno.env.get("SHOPIFY_MAX_ORDER_PAGES_PER_RUN") ?? "25");

    while (hasNextPage && orderPages < MAX_ORDER_PAGES && !hitSoftTimeout()) {
      orderPages++;
      const afterClause = cursor ? `, after: "${cursor}"` : "";
      let data: any;
      try {
        ({ data } = await shopifyQuery(`{
        orders(first: 50${afterClause}, sortKey: UPDATED_AT, reverse: true) {
          edges {
            cursor
            node {
              id
              name
              email
              currencyCode
              test
              note
              tags
              createdAt
              updatedAt
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
          }
          pageInfo { hasNextPage }
        }
      }`));
      } catch (err) {
        if (cursor && isInvalidCursorError(err)) {
          console.warn("Invalid Shopify cursor for orders; resetting checkpoint cursor and retrying from latest.");
          cursor = null;
          await saveCheckpointCursor("orders", null, false);
          orderPages--;
          continue;
        }
        throw err;
      }

      const edges = data?.orders?.edges || [];
      hasNextPage = data?.orders?.pageInfo?.hasNextPage || false;
      const pageShopifyOrderIds = edges
        .map((edge: any) => edge?.node?.id?.replace("gid://shopify/Order/", ""))
        .filter(Boolean);
      const existingOrderIds = new Set<string>();
      if (pageShopifyOrderIds.length > 0) {
        const { data: existingRows, error: existingErr } = await supabase
          .from("shopify_orders")
          .select("shopify_order_id")
          .in("shopify_order_id", pageShopifyOrderIds);
        if (existingErr) throw existingErr;
        for (const row of existingRows || []) {
          if ((row as any).shopify_order_id) existingOrderIds.add((row as any).shopify_order_id);
        }
      }
      const newOrdersPayload: Array<Record<string, unknown>> = [];
      const updateOrdersPayload: Array<Record<string, unknown>> = [];
      const lineItemsByShopifyOrderId = new Map<string, Array<Record<string, unknown>>>();

      for (const edge of edges) {
        if (hitSoftTimeout()) {
          hasNextPage = true;
          break;
        }
        cursor = edge.cursor;
        const o = edge.node;
        if (orderCutoffMs && o.updatedAt && new Date(o.updatedAt).getTime() <= orderCutoffMs) {
          orderReachedCutoff = true;
          hasNextPage = false;
          break;
        }
        const shopifyOrderId = o.id.replace("gid://shopify/Order/", "");
        const shopifyCustomerId = o.customer?.id?.replace("gid://shopify/Customer/", "") || null;

        const customerUuid = shopifyCustomerId ? customerIdByShopify.get(shopifyCustomerId) ?? null : null;
        const custName = o.customer?.displayName || "Unknown";
        const custEmail = o.customer?.defaultEmailAddress?.emailAddress || null;
        const orderTags = Array.isArray(o.tags) ? o.tags.join(", ") : "";
        const isNewOrder = !existingOrderIds.has(shopifyOrderId);
        if (isNewOrder) {
          insertedOrders++;
          existingOrderIds.add(shopifyOrderId);
        } else {
          updatedOrders++;
        }
        const row = {
          shopify_order_id: shopifyOrderId,
          order_number: o.name,
          customer_id: customerUuid,
          shopify_customer_id: shopifyCustomerId,
          customer_name: custName,
          email: o.email || custEmail,
          total: parseFloat(o.totalPriceSet?.shopMoney?.amount || "0"),
          currency_code: o.currencyCode || o.totalPriceSet?.shopMoney?.currencyCode || null,
          subtotal: parseFloat(o.subtotalPriceSet?.shopMoney?.amount || "0") || null,
          total_tax: parseFloat(o.currentTotalTaxSet?.shopMoney?.amount || "0") || null,
          financial_status: (o.displayFinancialStatus || "PENDING").toLowerCase(),
          fulfillment_status: (o.displayFulfillmentStatus || "UNFULFILLED").toLowerCase(),
          shopify_created_at: o.createdAt,
          processed_at: o.processedAt || null,
          order_note: o.note || null,
          tags: orderTags || null,
          test_order: Boolean(o.test),
        };
        if (isNewOrder) newOrdersPayload.push(row);
        else updateOrdersPayload.push(row);

        const lineItems = (o.lineItems?.edges || []).map((e: {
          node: {
            id: string;
            title: string;
            variantTitle: string;
            quantity: number;
            sku: string | null;
            variant: { id: string; sku: string | null } | null;
            originalUnitPriceSet: { shopMoney: { amount: string } };
          };
        }) => {
          const n = e.node;
          const variantGid = n.variant?.id || null;
          const lineGid = n.id?.replace("gid://shopify/LineItem/", "") || null;
          return {
            shopify_line_item_id: lineGid,
            shopify_variant_gid: variantGid,
            product: n.title,
            variant: n.variantTitle || "Default",
            sku: n.variant?.sku || n.sku || null,
            quantity: n.quantity,
            price: parseFloat(n.originalUnitPriceSet?.shopMoney?.amount || "0"),
          };
        });
        lineItemsByShopifyOrderId.set(shopifyOrderId, lineItems);
      }
      const ordersPayload = [...newOrdersPayload, ...updateOrdersPayload];
      if (ordersPayload.length > 0) {
        const upsertedOrders: { id: string; shopify_order_id: string }[] = [];
        if (newOrdersPayload.length > 0) {
          const { data: insertedRows, error: insertErr } = await supabase
            .from("shopify_orders")
            .upsert(newOrdersPayload, { onConflict: "shopify_order_id" })
            .select("id, shopify_order_id");
          if (insertErr) throw insertErr;
          upsertedOrders.push(...(insertedRows || []));
        }
        if (updateOrdersPayload.length > 0) {
          const { data: updatedRows, error: updateErr } = await supabase
            .from("shopify_orders")
            .upsert(updateOrdersPayload, { onConflict: "shopify_order_id" })
            .select("id, shopify_order_id");
          if (updateErr) throw updateErr;
          upsertedOrders.push(...(updatedRows || []));
        }

        const orderIdByShopify = new Map<string, string>(
          upsertedOrders.map((r) => [r.shopify_order_id, r.id]),
        );
        const orderIds = Array.from(orderIdByShopify.values());
        if (orderIds.length > 0) {
          const { error: deleteItemsErr } = await supabase
            .from("shopify_order_items")
            .delete()
            .in("order_id", orderIds);
          if (deleteItemsErr) throw deleteItemsErr;

          const lineItemsToInsert: Array<Record<string, unknown>> = [];
          for (const [shopifyOrderId, lineItems] of lineItemsByShopifyOrderId.entries()) {
            const orderId = orderIdByShopify.get(shopifyOrderId);
            if (!orderId || lineItems.length === 0) continue;
            for (const item of lineItems) {
              lineItemsToInsert.push({ order_id: orderId, ...item });
            }
          }

          if (lineItemsToInsert.length > 0) {
            const chunkSize = 1000;
            for (let i = 0; i < lineItemsToInsert.length; i += chunkSize) {
              const chunk = lineItemsToInsert.slice(i, i + chunkSize);
              const { error: liErr } = await supabase.from("shopify_order_items").insert(chunk);
              if (liErr) throw liErr;
            }
          }
        }

        totalSynced += ordersPayload.length;
        ordersPartialCount = totalSynced;
      }
      await flushRunningLog(ordersLogId, totalSynced);
      await saveCheckpointCursor("orders", cursor, !hasNextPage || orderReachedCutoff);
    }

    const orderNote = [
      SYNC_POLICY_NOTE,
      hitSoftTimeout()
        ? softTimeoutNote
        : hasNextPage
          ? `Stopped at ${MAX_ORDER_PAGES} pages; run sync again to pull more orders.`
          : totalSynced === 0
            ? "Already up to date (no new order changes)."
            : undefined,
      `Orders processed: ${totalSynced} (new: ${insertedOrders}, updated: ${updatedOrders}). Per page: new rows upserted before updates.`,
      checkpointUnavailable ? checkpointNote : undefined,
    ].filter(Boolean).join(" ");
    await finalizeSuccessLog(ordersLogId, totalSynced, orderNote);

    results.orders = {
      synced: totalSynced,
      status: "success",
      ...(orderNote ? { note: orderNote } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    results.orders = { synced: 0, status: "error", error: msg };
    if (ordersLogId) {
      await supabase.from("sync_logs").update({
        status: "error",
        error_message: msg,
        records_synced: ordersPartialCount,
        completed_at: new Date().toISOString(),
      }).eq("id", ordersLogId);
    }
  }
  }

  // --- SYNC PRODUCTS + VARIANTS (variant stock = inventory in this app) ---
  if (shouldRun("products")) {
  let productsLogId: string | null = null;
  let productsPartialCount = 0;
  try {
    productsLogId = crypto.randomUUID();
    await supabase.from("sync_logs").insert({ id: productsLogId, sync_type: "products", status: "running" });

    let hasNextPage = true;
    const productCheckpoint = await getCheckpoint("products");
    let cursor: string | null = productCheckpoint.cursor;
    const productCutoffMs = productCheckpoint.lastCompletedAt
      ? new Date(productCheckpoint.lastCompletedAt).getTime() - 5 * 60 * 1000
      : null;
    let productReachedCutoff = false;
    let totalSynced = 0;
    let productPages = 0;
    const MAX_PRODUCT_PAGES = Number(Deno.env.get("SHOPIFY_MAX_PRODUCT_PAGES_PER_RUN") ?? "25");

    const PRODUCT_PAGE_SIZE = Number(Deno.env.get("SHOPIFY_PRODUCT_PAGE_SIZE") ?? "20");
    const PRODUCT_VARIANT_PAGE_SIZE = Number(Deno.env.get("SHOPIFY_PRODUCT_VARIANT_PAGE_SIZE") ?? "25");
    const PRODUCT_INVENTORY_LEVEL_PAGE_SIZE = Number(Deno.env.get("SHOPIFY_PRODUCT_INVENTORY_LEVEL_PAGE_SIZE") ?? "3");
    while (hasNextPage && productPages < MAX_PRODUCT_PAGES && !hitSoftTimeout()) {
      productPages++;
      const afterClause = cursor ? `, after: "${cursor}"` : "";
      let data: any;
      try {
        ({ data } = await shopifyQuery(`{
        products(first: ${PRODUCT_PAGE_SIZE}${afterClause}, sortKey: UPDATED_AT, reverse: true) {
          edges {
            cursor
            node {
              id
              title
              handle
              status
              descriptionHtml
              tags
              vendor
              productType
              updatedAt
              variants(first: ${PRODUCT_VARIANT_PAGE_SIZE}) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    inventoryQuantity
                    inventoryItem {
                      inventoryLevels(first: ${PRODUCT_INVENTORY_LEVEL_PAGE_SIZE}) {
                        edges {
                          node {
                            quantities(names: ["available"]) {
                              name
                              quantity
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }`));
      } catch (err) {
        if (cursor && isInvalidCursorError(err)) {
          console.warn("Invalid Shopify cursor for products; resetting checkpoint cursor and retrying from latest.");
          cursor = null;
          await saveCheckpointCursor("products", null, false);
          productPages--;
          continue;
        }
        throw err;
      }

      const edges = data?.products?.edges || [];
      hasNextPage = data?.products?.pageInfo?.hasNextPage || false;

      for (const edge of edges) {
        if (hitSoftTimeout()) {
          hasNextPage = true;
          break;
        }
        cursor = edge.cursor;
        const p = edge.node;
        if (productCutoffMs && p.updatedAt && new Date(p.updatedAt).getTime() <= productCutoffMs) {
          productReachedCutoff = true;
          hasNextPage = false;
          break;
        }
        const shopifyProductId = p.id.replace("gid://shopify/Product/", "");
        const productTags = Array.isArray(p.tags) ? p.tags.join(", ") : "";

        const { data: prodRows, error: prodErr } = await supabase.from("shopify_products").upsert({
          shopify_product_id: shopifyProductId,
          title: p.title,
          vendor: p.vendor,
          category: p.productType || null,
          handle: p.handle || null,
          status: p.status || null,
          description_html: p.descriptionHtml || null,
          tags: productTags || null,
        }, { onConflict: "shopify_product_id" }).select("id");

        if (prodErr) throw prodErr;
        const prodData = prodRows?.[0];

        if (prodData?.id) {
          for (const ve of (p.variants?.edges || [])) {
            const v = ve.node;
            const shopifyVariantId = v.id.replace("gid://shopify/ProductVariant/", "");

            // Get inventory by location
            const invLevels = v.inventoryItem?.inventoryLevels?.edges || [];
            const primaryLocation = null;
            const totalStock = v.inventoryQuantity || 0;

            const { error: variantUpsertErr } = await supabase.from("shopify_variants").upsert({
              shopify_variant_id: shopifyVariantId,
              product_id: prodData.id,
              title: v.title,
              sku: v.sku,
              price: parseFloat(v.price || "0"),
              stock: totalStock,
              inventory_location: primaryLocation,
            }, { onConflict: "shopify_variant_id" });
            if (variantUpsertErr) throw variantUpsertErr;

            // Insert additional location-specific entries
            for (let i = 1; i < invLevels.length; i++) {
              const level = invLevels[i].node;
              const qty = level.quantities?.find((q: { name: string }) => q.name === "available")?.quantity || 0;
              // Store as a separate variant entry with location
              const { error: variantLocUpsertErr } = await supabase.from("shopify_variants").upsert({
                shopify_variant_id: `${shopifyVariantId}-loc-${i}`,
                product_id: prodData.id,
                title: v.title,
                sku: v.sku,
                price: parseFloat(v.price || "0"),
                stock: qty,
                inventory_location: null,
              }, { onConflict: "shopify_variant_id" });
              if (variantLocUpsertErr) throw variantLocUpsertErr;
            }
          }
        }

        totalSynced++;
        productsPartialCount = totalSynced;
      }
      await flushRunningLog(productsLogId, totalSynced);
      await saveCheckpointCursor("products", cursor, !hasNextPage || productReachedCutoff);
    }

    const productNote = [
      SYNC_POLICY_NOTE,
      hitSoftTimeout()
        ? softTimeoutNote
        : hasNextPage
          ? `Stopped at ${MAX_PRODUCT_PAGES} pages; run sync again for more products.`
          : totalSynced === 0
            ? "Already up to date (no new product changes)."
            : undefined,
      checkpointUnavailable ? checkpointNote : undefined,
    ].filter(Boolean).join(" ");
    await finalizeSuccessLog(productsLogId, totalSynced, productNote);

    results.products = {
      synced: totalSynced,
      status: "success",
      ...(productNote ? { note: productNote } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    results.products = { synced: 0, status: "error", error: msg };
    if (productsLogId) {
      await supabase.from("sync_logs").update({
        status: "error",
        error_message: msg,
        records_synced: productsPartialCount,
        completed_at: new Date().toISOString(),
      }).eq("id", productsLogId);
    }
  }
  }

  // --- SYNC COLLECTIONS ---
  if (shouldRun("collections")) {
  let collectionsLogId: string | null = null;
  let collectionsPartialCount = 0;
  try {
    collectionsLogId = crypto.randomUUID();
    await supabase.from("sync_logs").insert({ id: collectionsLogId, sync_type: "collections", status: "running" });

    let hasNextPage = true;
    const collCheckpoint = await getCheckpoint("collections");
    let cursor: string | null = collCheckpoint.cursor;
    const collCutoffMs = collCheckpoint.lastCompletedAt
      ? new Date(collCheckpoint.lastCompletedAt).getTime() - 5 * 60 * 1000
      : null;
    let collReachedCutoff = false;
    let collPages = 0;
    const MAX_COLLECTION_PAGES = Number(Deno.env.get("SHOPIFY_MAX_COLLECTION_PAGES_PER_RUN") ?? "50");
    let totalSynced = 0;
    while (hasNextPage && collPages < MAX_COLLECTION_PAGES && !hitSoftTimeout()) {
      collPages++;
      const afterClause = cursor ? `, after: "${cursor}"` : "";
      let data: any;
      try {
        ({ data } = await shopifyQuery(`{
        collections(first: 50${afterClause}, sortKey: UPDATED_AT, reverse: true) {
          edges {
            cursor
            node {
              id
              title
              handle
              updatedAt
              ruleSet { appliedDisjunctively }
              productsCount { count }
            }
          }
          pageInfo { hasNextPage }
        }
      }`));
      } catch (err) {
        if (cursor && isInvalidCursorError(err)) {
          console.warn("Invalid Shopify cursor for collections; resetting checkpoint cursor and retrying from latest.");
          cursor = null;
          await saveCheckpointCursor("collections", null, false);
          collPages--;
          continue;
        }
        throw err;
      }
      const edges = data?.collections?.edges || [];
      hasNextPage = data?.collections?.pageInfo?.hasNextPage || false;
      const pageCollectionIds = edges
        .map((edge: { node?: { id?: string } }) => edge?.node?.id?.replace("gid://shopify/Collection/", ""))
        .filter(Boolean) as string[];
      const existingCollectionIds = new Set<string>();
      if (pageCollectionIds.length > 0) {
        const { data: existingCollRows, error: existingCollErr } = await (supabase as any)
          .from("shopify_collections")
          .select("shopify_collection_id")
          .in("shopify_collection_id", pageCollectionIds);
        if (existingCollErr) throw existingCollErr;
        for (const row of existingCollRows || []) {
          if (row?.shopify_collection_id) existingCollectionIds.add(row.shopify_collection_id);
        }
      }
      const newCollectionPayloads: Array<Record<string, unknown>> = [];
      const updateCollectionPayloads: Array<Record<string, unknown>> = [];
      for (const edge of edges) {
        if (hitSoftTimeout()) {
          hasNextPage = true;
          break;
        }
        cursor = edge.cursor;
        const c = edge.node;
        if (collCutoffMs && c.updatedAt && new Date(c.updatedAt).getTime() <= collCutoffMs) {
          collReachedCutoff = true;
          hasNextPage = false;
          break;
        }
        const shopifyCollectionId = c.id.replace("gid://shopify/Collection/", "");
        const row = {
          shopify_collection_id: shopifyCollectionId,
          title: c.title,
          handle: c.handle || null,
          collection_type: c.ruleSet ? "smart" : "custom",
          products_count: Number(c.productsCount?.count ?? 0),
          published_at: null,
          updated_at: c.updatedAt || new Date().toISOString(),
        };
        const isNewColl = !existingCollectionIds.has(shopifyCollectionId);
        if (isNewColl) {
          existingCollectionIds.add(shopifyCollectionId);
          newCollectionPayloads.push(row);
        } else {
          updateCollectionPayloads.push(row);
        }
      }
      if (newCollectionPayloads.length > 0) {
        const { error: collNewErr } = await (supabase as any)
          .from("shopify_collections")
          .upsert(newCollectionPayloads, { onConflict: "shopify_collection_id" });
        if (collNewErr) throw collNewErr;
        totalSynced += newCollectionPayloads.length;
      }
      if (updateCollectionPayloads.length > 0) {
        const { error: collUpdErr } = await (supabase as any)
          .from("shopify_collections")
          .upsert(updateCollectionPayloads, { onConflict: "shopify_collection_id" });
        if (collUpdErr) throw collUpdErr;
        totalSynced += updateCollectionPayloads.length;
      }
      collectionsPartialCount = totalSynced;
      await flushRunningLog(collectionsLogId, totalSynced);
      await saveCheckpointCursor("collections", cursor, !hasNextPage || collReachedCutoff);
      if (edges.length === 0) break;
    }
    const collectionsNote = [
      SYNC_POLICY_NOTE,
      hitSoftTimeout()
        ? softTimeoutNote
        : hasNextPage
          ? `Stopped at ${MAX_COLLECTION_PAGES} pages; run sync again for more collections.`
          : totalSynced === 0
            ? "Already up to date (no collection changes)."
            : undefined,
      checkpointUnavailable ? checkpointNote : undefined,
    ].filter(Boolean).join(" ");
    await finalizeSuccessLog(collectionsLogId, totalSynced, collectionsNote || undefined);
    results.collections = { synced: totalSynced, status: "success", ...(collectionsNote ? { note: collectionsNote } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    results.collections = { synced: 0, status: "error", error: msg };
    if (collectionsLogId) {
      await supabase.from("sync_logs").update({
        status: "error",
        error_message: msg,
        records_synced: collectionsPartialCount,
        completed_at: new Date().toISOString(),
      }).eq("id", collectionsLogId);
    }
  }
  }

  // --- SYNC PURCHASE ORDERS (from tagged Shopify orders) ---
  if (shouldRun("purchase_orders")) {
  let poLogId: string | null = null;
  let poPartialCount = 0;
  try {
    poLogId = crypto.randomUUID();
    await supabase.from("sync_logs").insert({ id: poLogId, sync_type: "purchase_orders", status: "running" });
    let totalSynced = 0;
    let totalProcessed = 0;
    let insertedPo = 0;
    let updatedPo = 0;

    const { data: existingPoRows } = await (supabase as any)
      .from("purchase_orders")
      .select("po_number");
    const existingPoNumbers = new Set<string>((existingPoRows || []).map((r: any) => String(r.po_number)));

    const pageSize = 1000;
    let from = 0;
    let hasMore = true;
    while (hasMore && !hitSoftTimeout()) {
      const to = from + pageSize - 1;
      const { data: orderRows, error: orderReadErr } = await supabase
        .from("shopify_orders")
        .select(
          "id, order_number, customer_name, total, currency_code, shopify_created_at, processed_at, tags, order_note",
        )
        .order("shopify_created_at", { ascending: false, nullsFirst: false })
        .range(from, to);
      if (orderReadErr) throw orderReadErr;
      const batch = orderRows || [];
      if (batch.length === 0) break;

      const poNewByNumber = new Map<string, Record<string, unknown>>();
      const poUpdateByNumber = new Map<string, Record<string, unknown>>();
      for (const row of batch as any[]) {
        if (hitSoftTimeout()) break;
        totalProcessed++;
        const rawOrderNumber = String(row.order_number || "");
        const cleanOrderNumber = rawOrderNumber.replace(/^#/, "").trim();
        const tags = String(row.tags || "");
        const note = String(row.order_note || "");
        const text = `${cleanOrderNumber} ${tags} ${note}`.toLowerCase();
        const looksLikePoOrder =
          /(^|[^a-z0-9])po[-\s]?\d+/i.test(cleanOrderNumber) ||
          text.includes("purchase order") ||
          text.includes("purchase_order") ||
          text.includes("purchase-order") ||
          /(^|[\s,;])po($|[\s,;])/i.test(tags);
        if (!looksLikePoOrder) continue;

        const poNumber = cleanOrderNumber.toLowerCase().startsWith("po")
          ? cleanOrderNumber.toUpperCase()
          : `PO-${cleanOrderNumber || crypto.randomUUID().slice(0, 8)}`;
        const status = row.processed_at ? "received" : "open";
        const payload: Record<string, unknown> = {
          po_number: poNumber,
          shopify_order_id: row.id ?? null,
          supplier_name: row.customer_name || "Unknown Supplier",
          status,
          total_amount: Number(row.total || 0),
          currency_code: row.currency_code || "USD",
          po_date: row.shopify_created_at || new Date().toISOString(),
          expected_date: row.processed_at || null,
          notes: row.order_note || row.tags || null,
          source: "shopify_tagged_order",
        };
        if (existingPoNumbers.has(poNumber)) {
          if (!poUpdateByNumber.has(poNumber)) poUpdateByNumber.set(poNumber, payload);
        } else if (!poNewByNumber.has(poNumber)) {
          poNewByNumber.set(poNumber, payload);
        }
      }
      const poBatchNew = [...poNewByNumber.values()];
      const poBatchUpdate = [...poUpdateByNumber.values()];
      if (poBatchNew.length > 0) {
        const { error: poNewErr } = await (supabase as any).from("purchase_orders").upsert(poBatchNew, { onConflict: "po_number" });
        if (poNewErr) throw poNewErr;
        for (const p of poBatchNew) {
          existingPoNumbers.add(String(p.po_number));
          insertedPo++;
          totalSynced++;
        }
      }
      if (poBatchUpdate.length > 0) {
        const { error: poUpdErr } = await (supabase as any).from("purchase_orders").upsert(poBatchUpdate, { onConflict: "po_number" });
        if (poUpdErr) throw poUpdErr;
        updatedPo += poBatchUpdate.length;
        totalSynced += poBatchUpdate.length;
      }
      poPartialCount = totalSynced;

      await flushRunningLog(poLogId, totalSynced);
      hasMore = batch.length === pageSize;
      from += pageSize;
    }

    const poNote = [
      SYNC_POLICY_NOTE,
      hitSoftTimeout() ? softTimeoutNote : undefined,
      `Orders scanned: ${totalProcessed} (newest first). Purchase orders matched: ${totalSynced} (new: ${insertedPo}, updated: ${updatedPo}).`,
      checkpointUnavailable ? checkpointNote : undefined,
    ].filter(Boolean).join(" ");

    await finalizeSuccessLog(poLogId, totalSynced, poNote || undefined);
    results.purchase_orders = {
      synced: totalSynced,
      status: "success",
      ...(poNote ? { note: poNote } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    results.purchase_orders = { synced: 0, status: "error", error: msg };
    if (poLogId) {
      await supabase.from("sync_logs").update({
        status: "error",
        error_message: msg,
        records_synced: poPartialCount,
        completed_at: new Date().toISOString(),
      }).eq("id", poLogId);
    }
  }
  }

  return new Response(
    JSON.stringify({
      success: true,
      sync_policy: SYNC_POLICY_NOTE,
      results,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("shopify-sync error:", err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
