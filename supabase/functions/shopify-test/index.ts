import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/require-admin.ts";
import {
  looksLikeShopifyCustomAppAdminToken,
  normalizeShopifyAdminToken,
  normalizeShopifyDomain,
  shopifyAdminGraphqlUrl,
} from "../_shared/shopify-credentials.ts";
import { resolveShopifyAuth } from "../_shared/shopify-auth.ts";

const isDev = (Deno.env.get("ENV") || Deno.env.get("DENO_ENV") || "").toLowerCase() === "development";
const devError = (...args: unknown[]) => {
  if (!isDev) return;
  console.error(...args);
};

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const denied = await requireAdmin(req, corsHeaders);
    if (denied) return denied;

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const bodyDomain = typeof body?.shopify_store_domain === "string" ? body.shopify_store_domain : "";
    const bodyToken = typeof body?.shopify_access_token === "string" ? body.shopify_access_token : "";
    const bodyClientId = typeof body?.shopify_client_id === "string" ? body.shopify_client_id : "";
    const bodyClientSecret = typeof body?.shopify_client_secret === "string" ? body.shopify_client_secret : "";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const domain = normalizeShopifyDomain(bodyDomain);
    const token = normalizeShopifyAdminToken(bodyToken);

    let auth;
    try {
      auth = await resolveShopifyAuth(supabase, {
        overrideDomain: domain || undefined,
        overrideAccessToken: token || undefined,
        overrideClientId: bodyClientId || undefined,
        overrideClientSecret: bodyClientSecret || undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to resolve Shopify credentials";
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!looksLikeShopifyCustomAppAdminToken(auth.accessToken)) {
      return new Response(
        JSON.stringify({
          error:
            "Resolved Shopify token is not a custom app Admin API token (shpat_...). Set valid shopify_client_id/shopify_client_secret in Settings or paste a valid shpat token.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const graphqlUrl = shopifyAdminGraphqlUrl(auth.shopDomain);
    const res = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": auth.accessToken,
      },
      body: JSON.stringify({ query: "{ shop { name currencyCode primaryDomain { host } } }" }),
    });

    const text = await res.text();
    let json: {
      errors?: { message?: string }[] | string;
      data?: { shop?: { name?: string; currencyCode?: string; primaryDomain?: { host?: string } } };
    } = {};
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      if (res.status === 401 || res.status === 403) {
        return unauthorizedResponse();
      }
      return new Response(
        JSON.stringify({
          error:
            `Shopify did not return JSON (HTTP ${res.status}). Usually the store domain is wrong (must be *.myshopify.com), the shop is unreachable, or a proxy returned HTML. Snippet: ${text.slice(0, 120).replace(/\s+/g, " ")}`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const errorsStr =
      typeof json.errors === "string"
        ? json.errors
        : Array.isArray(json.errors)
          ? json.errors.map((e) => e.message).filter(Boolean).join("; ")
          : "";

    if (res.status === 401 || res.status === 403 || /invalid api key|unrecognized login|wrong password/i.test(errorsStr)) {
      return unauthorizedResponse();
    }

    if (!res.ok) {
      return new Response(
        JSON.stringify({
          error: errorsStr || `Shopify HTTP ${res.status}: ${text.slice(0, 400)}`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (errorsStr) {
      return new Response(JSON.stringify({ error: `Shopify GraphQL: ${errorsStr}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, token_source: auth.tokenSource, shop: json.data?.shop }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    devError("shopify-test error:", err);
    return new Response(JSON.stringify({ error: `Connection test failed: ${msg}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function unauthorizedResponse() {
  return new Response(
    JSON.stringify({
      error:
        "Invalid Admin API access token or wrong store domain. Confirm: (1) Domain is only your-store.myshopify.com — no https. (2) Token is the Admin API access token from the same store’s custom app (shpat_…). (3) Save settings, then test again.",
    }),
    { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}
