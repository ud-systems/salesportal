import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";

// Set SUPABASE_PROJECT_REF (and optionally SHOPIFY_WEBHOOK_CALLBACK_URL) before running.
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "YOUR_SUPABASE_PROJECT_REF";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const CALLBACK_URL =
  process.env.SHOPIFY_WEBHOOK_CALLBACK_URL || `https://${PROJECT_REF}.supabase.co/functions/v1/shopify-webhook`;
const API_VERSION = "2025-01";

const TOPICS = [
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
];

function normalizeDomain(raw = "") {
  return raw.trim().replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
}

function normalizeToken(raw = "") {
  return raw.trim().replace(/^\uFEFF/, "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, "");
}

function getServiceRoleKey() {
  const raw = execSync(`npx supabase projects api-keys --project-ref ${PROJECT_REF} -o json`, { encoding: "utf-8" });
  const keys = JSON.parse(raw);
  const svc = keys.find((k) => k.id === "service_role" || k.name === "service_role");
  if (!svc?.api_key) throw new Error("Service role key not found");
  return svc.api_key;
}

async function refreshToken(domain, clientId, clientSecret) {
  const url = new URL(`https://${domain}/admin/oauth/access_token`);
  url.searchParams.set("grant_type", "client_credentials");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  const res = await fetch(url.toString(), { method: "POST" });
  const text = await res.text();
  const json = JSON.parse(text);
  if (!res.ok) throw new Error(`Token refresh failed [${res.status}]: ${text}`);
  return {
    token: normalizeToken(String(json.access_token || "")),
    expiresAt: new Date(Date.now() + Number(json.expires_in || 86400) * 1000).toISOString(),
  };
}

async function shopifyGraphql(domain, token, query, variables = {}) {
  const res = await fetch(`https://${domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  const json = JSON.parse(text);
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${text}`);
  if (json.errors?.length) throw new Error(`Shopify GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
  return json.data;
}

async function main() {
  const serviceRoleKey = getServiceRoleKey();
  const supabase = createClient(SUPABASE_URL, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", [
      "shopify_store_domain",
      "shopify_access_token",
      "shopify_access_token_expires_at",
      "shopify_client_id",
      "shopify_client_secret",
    ]);
  if (error) throw error;

  const map = Object.fromEntries((data || []).map((r) => [r.key, r.value || ""]));
  const domain = normalizeDomain(map.shopify_store_domain);
  if (!domain) throw new Error("shopify_store_domain missing in app_settings");

  let token = normalizeToken(map.shopify_access_token);
  const expiresAt = map.shopify_access_token_expires_at || "";
  const nearExpiry = !expiresAt || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now() + 300000;
  const clientId = (map.shopify_client_id || "").trim();
  const clientSecret = normalizeToken(map.shopify_client_secret || "");

  if (!token || nearExpiry) {
    if (!clientId || !clientSecret) throw new Error("Token missing/expiring and client credentials missing");
    const refreshed = await refreshToken(domain, clientId, clientSecret);
    token = refreshed.token;
    await supabase.from("app_settings").upsert({ key: "shopify_access_token", value: token }, { onConflict: "key" });
    await supabase
      .from("app_settings")
      .upsert({ key: "shopify_access_token_expires_at", value: refreshed.expiresAt }, { onConflict: "key" });
    console.log("Refreshed Shopify token.");
  }

  const listQuery = `query {
    webhookSubscriptions(first: 100) {
      edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
    }
  }`;
  const existing = await shopifyGraphql(domain, token, listQuery);
  const existingSet = new Set(
    (existing.webhookSubscriptions.edges || [])
      .map((e) => e.node)
      .filter((n) => n?.endpoint?.callbackUrl === CALLBACK_URL)
      .map((n) => n.topic),
  );

  const createMutation = `mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $url: URL!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) {
      userErrors { field message }
      webhookSubscription { id topic }
    }
  }`;

  for (const topic of TOPICS) {
    if (existingSet.has(topic)) {
      console.log(`Exists: ${topic}`);
      continue;
    }
    const created = await shopifyGraphql(domain, token, createMutation, { topic, url: CALLBACK_URL });
    const errs = created.webhookSubscriptionCreate.userErrors || [];
    if (errs.length) {
      throw new Error(`Failed ${topic}: ${errs.map((e) => e.message).join("; ")}`);
    }
    console.log(`Created: ${topic}`);
  }

  const verify = await shopifyGraphql(domain, token, listQuery);
  const rows = (verify.webhookSubscriptions.edges || [])
    .map((e) => e.node)
    .filter((n) => n?.endpoint?.callbackUrl === CALLBACK_URL)
    .map((n) => ({ id: n.id, topic: n.topic, callbackUrl: n.endpoint.callbackUrl }));
  console.log("Webhook subscriptions to callback URL:");
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
