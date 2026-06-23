import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/require-admin.ts";
import {
  looksLikeShopifyCustomAppAdminToken,
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
import { mapShopifyOrderMoneyFields } from "../_shared/shopify-order-totals.ts";
import { extractOrderReportingFields, parseOrderSubtotalFromNode } from "../_shared/shopify-order-reporting.ts";
import { mapGraphqlLineItemEdgesToPayload } from "../_shared/shopify-order-line-items.ts";
import { SHOPIFY_ORDER_DETAIL_GQL, upsertShopifyOrderFromGraphqlNode } from "../_shared/shopify-order-graphql-upsert.ts";
import { recordRefundDeltaIfIncreased } from "../_shared/shopify-order-refund-delta.ts";
import { syncShopifyAnalyticsOrderFacts } from "../_shared/shopify-analytics-facts-sync.ts";

const isDev = (Deno.env.get("ENV") || Deno.env.get("DENO_ENV") || "").toLowerCase() === "development";
const devError = (...args: unknown[]) => {
  if (!isDev) return;
  console.error(...args);
};
const devWarn = (...args: unknown[]) => {
  if (!isDev) return;
  console.warn(...args);
};

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const anyErr = err as { message?: string; details?: string; hint?: string; code?: string };
    const parts = [anyErr.message, anyErr.details, anyErr.hint, anyErr.code].filter(Boolean);
    if (parts.length > 0) return parts.join(" | ");
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  }
  return "Unknown error";
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

async function assertDataPulseLicenseActive(
  supabase: ReturnType<typeof createClient>,
): Promise<{ code: string; expiresAt: string }> {
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

  if (!code) throw new Error("Sync locked: missing DataPulse access code in Settings.");
  if (mode !== "lifetime") {
    const expiresMs = new Date(expiresAt).getTime();
    if (!expiresAt || Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
      throw new Error("Sync locked: DataPulse access code expired. Add and validate a new code.");
    }
  }

  const res = await fetch(validationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const payload = await res.json().catch(() => ({} as { valid?: boolean; lifetime?: boolean; expires_at?: string; error?: string }));
  if (!res.ok || !payload?.valid) {
    throw new Error(payload?.error || "Sync locked: DataPulse code is invalid or expired.");
  }
  const isLifetime = payload?.lifetime === true || mode === "lifetime";
  if (!isLifetime && payload.expires_at && new Date(payload.expires_at).getTime() <= Date.now()) {
    throw new Error("Sync locked: DataPulse access code expired. Add and validate a new code.");
  }

  return { code, expiresAt: payload.expires_at || expiresAt };
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
  const targetSalespersonIds: string[] = [];
  for (const row of payloads) {
    if (seen.has(row.salesperson_user_id)) continue;
    seen.add(row.salesperson_user_id);
    targetSalespersonIds.push(row.salesperson_user_id);
    const { error } = await supabase.from("salesperson_customer_assignments").upsert(row, {
      onConflict: "customer_id,salesperson_user_id",
    });
    if (error) devError("salesperson_customer_assignments upsert:", error.message, row);
  }

  const { data: existingRows, error: existingErr } = await supabase
    .from("salesperson_customer_assignments")
    .select("id, salesperson_user_id")
    .eq("customer_id", customerUuid)
    .in("source", ["sp_assigned", "referred_by"]);
  if (existingErr) {
    devError("salesperson_customer_assignments read for prune:", existingErr.message, { customerUuid });
    return;
  }

  const staleAssignmentIds = (existingRows || [])
    .filter((row) => !targetSalespersonIds.includes((row as { salesperson_user_id: string }).salesperson_user_id))
    .map((row) => (row as { id: string }).id);
  if (staleAssignmentIds.length > 0) {
    const { error: deleteErr } = await supabase
      .from("salesperson_customer_assignments")
      .delete()
      .in("id", staleAssignmentIds);
    if (deleteErr) {
      devError("salesperson_customer_assignments stale prune:", deleteErr.message, { customerUuid, staleAssignmentIds });
    }
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
  await assertDataPulseLicenseActive(supabase);
  const requestBody = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const resetCustomerCheckpoint = requestBody?.reset_customer_checkpoint === true;
  /** Clears orders checkpoint so the next run walks newest-first without the updatedAt incremental cutoff (backfills e.g. original_total after schema changes). */
  const resetOrdersCheckpoint = requestBody?.reset_orders_checkpoint === true;
  const requestedModule = typeof requestBody?.module === "string" ? requestBody.module : null;
  const allowedModules = new Set(["customers", "orders", "products", "collections", "purchase_orders", "analytics"]);
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
    if (error) devError("sync_logs progress update failed:", error.message, { logId, count });
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
      devError("sync_checkpoints read failed:", error.message, { syncType });
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
      devError("sync_checkpoints upsert failed:", error.message, { syncType, cursor, completed });
    }
  };
  const isInvalidCursorError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err || "");
    return /Invalid cursor for current pagination sort/i.test(msg);
  };

  /** Shopify lists use sortKey UPDATED_AT reverse:true → newest changes first. Per page/batch we upsert new rows before updates where applicable. */
  const SYNC_POLICY_NOTE =
    "Policy: newest-first from Shopify (UPDATED_AT desc); customers, orders, collections, and PO batches write new rows before updates; products stay per-product (variants need parent row id).";

  const refreshIdsRaw = requestBody?.refresh_shopify_order_ids;
  const refreshIdsList = Array.isArray(refreshIdsRaw)
    ? refreshIdsRaw.map((x: unknown) => String(x).trim()).filter((s) => s.length > 0)
    : [];
  const dedupRefreshIds = [...new Set(refreshIdsList)];
  const autoStaleFinancial = requestBody?.refresh_auto_stale_financial === true;

  if (dedupRefreshIds.length > 0 || autoStaleFinancial) {
    const MAX_REFRESH = 40;
    const merged: string[] = [];
    for (const id of dedupRefreshIds) {
      if (merged.length >= MAX_REFRESH) break;
      merged.push(id);
    }
    if (autoStaleFinancial && merged.length < MAX_REFRESH) {
      const { data: staleRows, error: staleErr } = await supabase.rpc("get_shopify_order_ids_stale_refunded_totals", {
        _limit: MAX_REFRESH - merged.length,
      });
      if (staleErr) devError("get_shopify_order_ids_stale_refunded_totals:", staleErr.message);
      for (const row of staleRows || []) {
        const sid = (row as { shopify_order_id?: string }).shopify_order_id;
        if (!sid || merged.includes(sid)) continue;
        merged.push(sid);
        if (merged.length >= MAX_REFRESH) break;
      }
    }

    const toOrderGid = (raw: string) => {
      const s = String(raw).trim();
      if (s.startsWith("gid://shopify/Order/")) return s;
      const digits = s.replace(/\D/g, "");
      if (digits.length > 0) return `gid://shopify/Order/${digits}`;
      return `gid://shopify/Order/${s.replace(/^#/, "")}`;
    };

    const resolveLookupOnly = async (customerGid: string | null) => {
      if (!customerGid) return null;
      const shopifyCustomerNumeric = customerGid.replace("gid://shopify/Customer/", "");
      const { data: customerRow } = await supabase
        .from("shopify_customers")
        .select("id")
        .eq("shopify_customer_id", shopifyCustomerNumeric)
        .maybeSingle();
      return customerRow?.id || null;
    };

    const refreshResults: { shopify_order_id: string; ok: boolean; order_id?: string; error?: string }[] = [];
    for (const rawId of merged.slice(0, MAX_REFRESH)) {
      const gid = toOrderGid(rawId);
      try {
        const json = await shopifyQuery(SHOPIFY_ORDER_DETAIL_GQL, { id: gid });
        const hit = await upsertShopifyOrderFromGraphqlNode(
          supabase,
          json.data?.order as Record<string, unknown> | undefined,
          resolveLookupOnly,
        );
        if (!hit) {
          refreshResults.push({ shopify_order_id: rawId, ok: false, error: "Order not found in Shopify or empty response" });
        } else {
          refreshResults.push({ shopify_order_id: hit.shopify_order_id, ok: true, order_id: hit.orderId });
        }
      } catch (e) {
        refreshResults.push({
          shopify_order_id: rawId,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        mode: "order_financial_refresh",
        refreshed: refreshResults.filter((r) => r.ok).length,
        failed: refreshResults.filter((r) => !r.ok).length,
        results: refreshResults,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // --- SYNC CUSTOMERS ---
  if (shouldRun("customers")) {
  let customersLogId: string | null = null;
  let customersPartialCount = 0;
  const rfmRefreshCustomerIds = new Set<string>();
  try {
    customersLogId = crypto.randomUUID();
    await supabase.from("sync_logs").insert({ id: customersLogId, sync_type: "customers", status: "running" });

    if (resetCustomerCheckpoint) {
      const { error: resetCpErr } = await supabase.from("sync_checkpoints").upsert(
        {
          sync_type: "customers",
          cursor: null,
          last_completed_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "sync_type" },
      );
      if (resetCpErr) devError("reset_customer_checkpoint upsert failed:", resetCpErr.message);
    }

    let hasNextPage = true;
    const customerCheckpoint = await getCheckpoint("customers");
    let cursor: string | null = customerCheckpoint.cursor;
    const customerCutoffMs = customerCheckpoint.lastCompletedAt
      ? new Date(customerCheckpoint.lastCompletedAt).getTime() - 5 * 60 * 1000
      : null;
    let customerReachedCutoff = false;
    let totalSynced = 0;
    let customerPages = 0;
    let incrementalCutoffHit = false;
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
              metafields(first: 80) {
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
          devWarn("Invalid Shopify cursor for customers; resetting checkpoint cursor and retrying from latest.");
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
          incrementalCutoffHit = true;
          hasNextPage = false;
          break;
        }
        const shopifyId = c.id.replace("gid://shopify/Customer/", "");
        const metafields = c.metafields?.edges?.map((e: { node: { namespace: string; key: string; value: string } }) => e.node) || [];
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

        // If Shopify doesn't set SP_Assigned (or sets "Unassigned"), infer it from `referred_by`
        // so UI assignment status stays correct.
        if (!spAssigned || spAssigned.trim().toLowerCase() === "unassigned") {
          const hit = findSalespersonRow(salespeople, referredBy);
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
          rfmRefreshCustomerIds.add(row.id);
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
            ? incrementalCutoffHit
              ? "Incremental window: no Shopify customer updatedAt is newer than your last completed customer sync (minus 5 min), so nothing was re-imported. Use reset_customer_checkpoint / “Full customer resync” to rebuild all customer rows (e.g. after code or metafield logic changes)."
              : "Already up to date (no customer rows to process this run)."
            : undefined,
      checkpointUnavailable ? checkpointNote : undefined,
    ].filter(Boolean).join(" ");
    await finalizeSuccessLog(customersLogId, totalSynced, customerNote);
    customersPartialCount = totalSynced;
    if (rfmRefreshCustomerIds.size > 0) {
      const { error: rfmErr } = await supabase.rpc("refresh_customer_rfm_metrics", {
        _customer_ids: Array.from(rfmRefreshCustomerIds),
      });
      if (rfmErr) devError("refresh_customer_rfm_metrics customers module:", rfmErr.message, { count: rfmRefreshCustomerIds.size });
    }

    results.customers = {
      synced: totalSynced,
      status: "success",
      ...(customerNote ? { note: customerNote } : {}),
    };
  } catch (err) {
    const msg = toErrorMessage(err);
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
  const rfmRefreshCustomerIds = new Set<string>();
  try {
    ordersLogId = crypto.randomUUID();
    await supabase.from("sync_logs").insert({ id: ordersLogId, sync_type: "orders", status: "running" });

    if (resetOrdersCheckpoint) {
      const { error: resetOrdErr } = await supabase.from("sync_checkpoints").upsert(
        {
          sync_type: "orders",
          cursor: null,
          last_completed_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "sync_type" },
      );
      if (resetOrdErr) devError("reset_orders_checkpoint upsert failed:", resetOrdErr.message);
    }

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
          }
          pageInfo { hasNextPage }
        }
      }`));
      } catch (err) {
        if (cursor && isInvalidCursorError(err)) {
          devWarn("Invalid Shopify cursor for orders; resetting checkpoint cursor and retrying from latest.");
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
      const existingRefundByShopify = new Map<string, number | null>();
      if (pageShopifyOrderIds.length > 0) {
        const { data: existingRows, error: existingErr } = await supabase
          .from("shopify_orders")
          .select("shopify_order_id, reporting_total_refunded")
          .in("shopify_order_id", pageShopifyOrderIds);
        if (existingErr) throw existingErr;
        for (const row of existingRows || []) {
          const shopifyId = (row as { shopify_order_id?: string }).shopify_order_id;
          if (shopifyId) {
            existingOrderIds.add(shopifyId);
            existingRefundByShopify.set(
              shopifyId,
              (row as { reporting_total_refunded?: number | null }).reporting_total_refunded ?? null,
            );
          }
        }
      }
      const newOrdersPayload: Array<Record<string, unknown>> = [];
      const updateOrdersPayload: Array<Record<string, unknown>> = [];
      const lineItemsByShopifyOrderId = new Map<string, Array<Record<string, unknown>>>();
      const fulfillmentsByShopifyOrderId = new Map<string, Array<{
        shopify_fulfillment_id: string;
        shipment_status: string | null;
        tracking_company: string | null;
        tracking_number: string | null;
        tracking_url: string | null;
        fulfilled_at: string | null;
        raw_payload: Record<string, unknown>;
      }>>();

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
        if (customerUuid) rfmRefreshCustomerIds.add(customerUuid);
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
        const rep = extractOrderReportingFields(o as Record<string, unknown>);
        const money = mapShopifyOrderMoneyFields(o, {
          financialStatus: o.displayFinancialStatus,
          reportingTotalRefunded: rep.reporting_total_refunded,
          orderEdited: Boolean(o.edited),
        });
        const fulfillmentNodes = (o.fulfillments || []) as Array<{
          id?: string;
          status?: string;
          createdAt?: string;
          trackingInfo?: Array<{ company?: string; number?: string; url?: string }>;
        }>;
        const flattenedFulfillments: Array<{
          shopify_fulfillment_id: string;
          shipment_status: string | null;
          tracking_company: string | null;
          tracking_number: string | null;
          tracking_url: string | null;
          fulfilled_at: string | null;
          raw_payload: Record<string, unknown>;
        }> = [];
        for (const node of fulfillmentNodes) {
          if (!node?.id) continue;
          const fulfillmentId = String(node.id).replace("gid://shopify/Fulfillment/", "");
          const trackingInfo = Array.isArray(node.trackingInfo) ? node.trackingInfo : [];
          if (trackingInfo.length === 0) {
            flattenedFulfillments.push({
              shopify_fulfillment_id: fulfillmentId,
              shipment_status: node.status ? String(node.status).toLowerCase() : null,
              tracking_company: null,
              tracking_number: null,
              tracking_url: null,
              fulfilled_at: node.createdAt || null,
              raw_payload: node as unknown as Record<string, unknown>,
            });
            continue;
          }
          for (const tracking of trackingInfo) {
            flattenedFulfillments.push({
              shopify_fulfillment_id: tracking?.number ? `${fulfillmentId}:${String(tracking.number)}` : fulfillmentId,
              shipment_status: node.status ? String(node.status).toLowerCase() : null,
              tracking_company: tracking?.company || null,
              tracking_number: tracking?.number || null,
              tracking_url: tracking?.url || null,
              fulfilled_at: node.createdAt || null,
              raw_payload: node as unknown as Record<string, unknown>,
            });
          }
        }
        const latestFulfillment = flattenedFulfillments
          .slice()
          .sort((a, b) => String(b.fulfilled_at || "").localeCompare(String(a.fulfilled_at || "")))[0];
        const row = {
          shopify_order_id: shopifyOrderId,
          order_number: o.name,
          customer_id: customerUuid,
          shopify_customer_id: shopifyCustomerId,
          customer_name: custName,
          email: o.email || custEmail,
          total: money.total,
          original_total: money.original_total,
          current_total: money.current_total,
          currency_code: o.currencyCode || o.totalPriceSet?.shopMoney?.currencyCode || null,
          subtotal: parseOrderSubtotalFromNode(o as Record<string, unknown>),
          total_tax: parseFloat(o.currentTotalTaxSet?.shopMoney?.amount || "0") || null,
          financial_status: (o.displayFinancialStatus || "PENDING").toLowerCase(),
          fulfillment_status: (o.displayFulfillmentStatus || "UNFULFILLED").toLowerCase(),
          shopify_created_at: o.createdAt,
          processed_at: o.processedAt || null,
          order_note: o.note || null,
          tags: orderTags || null,
          test_order: Boolean(o.test),
          updated_at: new Date().toISOString(),
          reporting_line_items_gross: rep.reporting_line_items_gross,
          reporting_original_total_discounts: rep.reporting_original_total_discounts,
          reporting_total_discounts: rep.reporting_total_discounts,
          reporting_total_shipping: rep.reporting_total_shipping,
          reporting_total_refunded: rep.reporting_total_refunded,
          taxes_included: rep.taxes_included,
          latest_tracking_number: latestFulfillment?.tracking_number || null,
          latest_tracking_url: latestFulfillment?.tracking_url || null,
          latest_tracking_company: latestFulfillment?.tracking_company || null,
          latest_tracking_status: latestFulfillment?.shipment_status || null,
          latest_fulfillment_updated_at: latestFulfillment?.fulfilled_at || null,
        };
        if (isNewOrder) newOrdersPayload.push(row);
        else updateOrdersPayload.push(row);

        const lineItems = mapGraphqlLineItemEdgesToPayload(o.lineItems?.edges);
        lineItemsByShopifyOrderId.set(shopifyOrderId, lineItems);
        fulfillmentsByShopifyOrderId.set(shopifyOrderId, flattenedFulfillments);
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
        for (const row of updateOrdersPayload) {
          const shopifyOrderId = String(row.shopify_order_id || "");
          const orderId = orderIdByShopify.get(shopifyOrderId);
          if (!orderId) continue;
          await recordRefundDeltaIfIncreased(
            supabase,
            orderId,
            existingRefundByShopify.get(shopifyOrderId),
            row.reporting_total_refunded as number | null | undefined,
          );
        }
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

          const { error: deleteFulfillmentErr } = await supabase
            .from("shopify_order_fulfillments")
            .delete()
            .in("order_id", orderIds);
          if (deleteFulfillmentErr) throw deleteFulfillmentErr;

          const fulfillmentRowsToInsert: Array<Record<string, unknown>> = [];
          for (const [shopifyOrderId, orderId] of orderIdByShopify.entries()) {
            const fulfillments = fulfillmentsByShopifyOrderId.get(shopifyOrderId) || [];
            for (const fulfillment of fulfillments) {
              fulfillmentRowsToInsert.push({
                order_id: orderId,
                ...fulfillment,
              });
            }
          }
          const dedupedFulfillmentRows = dedupeFulfillmentRows(fulfillmentRowsToInsert);
          if (dedupedFulfillmentRows.length > 0) {
            const chunkSize = 1000;
            for (let i = 0; i < dedupedFulfillmentRows.length; i += chunkSize) {
              const chunk = dedupedFulfillmentRows.slice(i, i + chunkSize);
              const { error: insFulfillmentErr } = await supabase.from("shopify_order_fulfillments").insert(chunk);
              if (insFulfillmentErr) throw insFulfillmentErr;
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
            ? orderCutoffMs
              ? "Incremental window: no Shopify order updatedAt is newer than your last completed orders sync (minus 5 min), so nothing was re-imported. Use reset_orders_checkpoint / “Rebuild order totals” to walk orders again (e.g. after original_total or pricing field changes)."
              : "Already up to date (no order rows in this run)."
            : undefined,
      `Orders processed: ${totalSynced} (new: ${insertedOrders}, updated: ${updatedOrders}). Per page: new rows upserted before updates.`,
      checkpointUnavailable ? checkpointNote : undefined,
    ].filter(Boolean).join(" ");
    await finalizeSuccessLog(ordersLogId, totalSynced, orderNote);
    if (rfmRefreshCustomerIds.size > 0) {
      const { error: rfmErr } = await supabase.rpc("refresh_customer_rfm_metrics", {
        _customer_ids: Array.from(rfmRefreshCustomerIds),
      });
      if (rfmErr) devError("refresh_customer_rfm_metrics orders module:", rfmErr.message, { count: rfmRefreshCustomerIds.size });
    }

    results.orders = {
      synced: totalSynced,
      status: "success",
      ...(orderNote ? { note: orderNote } : {}),
    };

    try {
      const analyticsResult = await syncShopifyAnalyticsOrderFacts(
        supabase,
        SHOPIFY_STORE_DOMAIN,
        SHOPIFY_ACCESS_TOKEN,
      );
      results.analytics = analyticsResult.skipped
        ? { synced: 0, status: "skipped", note: analyticsResult.error }
        : {
          synced: analyticsResult.synced,
          status: "success",
          ...(analyticsResult.query ? { note: analyticsResult.query } : {}),
        };
    } catch (analyticsErr) {
      const analyticsMsg = toErrorMessage(analyticsErr);
      devWarn("shopify analytics facts sync after orders:", analyticsMsg);
      results.analytics = { synced: 0, status: "error", error: analyticsMsg };
    }
  } catch (err) {
    const msg = toErrorMessage(err);
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
              featuredImage {
                url
              }
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
          devWarn("Invalid Shopify cursor for products; resetting checkpoint cursor and retrying from latest.");
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

        const featuredUrl = p.featuredImage?.url || null;
        const { data: prodRows, error: prodErr } = await supabase.from("shopify_products").upsert({
          shopify_product_id: shopifyProductId,
          title: p.title,
          vendor: p.vendor,
          category: p.productType || null,
          handle: p.handle || null,
          status: p.status || null,
          description_html: p.descriptionHtml || null,
          tags: productTags || null,
          featured_image_url: featuredUrl,
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
    const msg = toErrorMessage(err);
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
          devWarn("Invalid Shopify cursor for collections; resetting checkpoint cursor and retrying from latest.");
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
    const msg = toErrorMessage(err);
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
    const msg = toErrorMessage(err);
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

  if (shouldRun("analytics") && !results.analytics) {
    let analyticsLogId: string | null = null;
    try {
      analyticsLogId = crypto.randomUUID();
      await supabase.from("sync_logs").insert({ id: analyticsLogId, sync_type: "analytics", status: "running" });
      const analyticsResult = await syncShopifyAnalyticsOrderFacts(
        supabase,
        SHOPIFY_STORE_DOMAIN,
        SHOPIFY_ACCESS_TOKEN,
        {
          throughDay: typeof requestBody?.through_day === "string" ? requestBody.through_day : undefined,
        },
      );
      const analyticsNote = analyticsResult.skipped
        ? analyticsResult.error
        : analyticsResult.query;
      await finalizeSuccessLog(analyticsLogId, analyticsResult.synced, analyticsNote || undefined);
      results.analytics = analyticsResult.skipped
        ? { synced: 0, status: "skipped", note: analyticsResult.error }
        : { synced: analyticsResult.synced, status: "success", ...(analyticsNote ? { note: analyticsNote } : {}) };
    } catch (err) {
      const msg = toErrorMessage(err);
      results.analytics = { synced: 0, status: "error", error: msg };
      if (analyticsLogId) {
        await supabase.from("sync_logs").update({
          status: "error",
          error_message: msg,
          completed_at: new Date().toISOString(),
        }).eq("id", analyticsLogId);
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
    const msg = toErrorMessage(err);
    devError("shopify-sync error:", err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
