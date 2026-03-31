import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  normalizeShopifyAdminToken,
  normalizeShopifyDomain,
} from "./shopify-credentials.ts";

type SettingRow = { key: string; value: string | null };

type ResolveShopifyAuthOptions = {
  overrideDomain?: string;
  overrideAccessToken?: string;
  overrideClientId?: string;
  overrideClientSecret?: string;
  forceRefresh?: boolean;
};

type ShopifyAuthResult = {
  shopDomain: string;
  accessToken: string;
  tokenSource: "cached" | "refreshed" | "override";
  expiresAt?: string | null;
};

const REFRESH_BUFFER_SECONDS = 300;

function mapSettings(rows: SettingRow[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows || []) {
    if (!r.key) continue;
    out[r.key] = r.value || "";
  }
  return out;
}

function isExpiryNear(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return true;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return true;
  const cutoff = Date.now() + REFRESH_BUFFER_SECONDS * 1000;
  return ms <= cutoff;
}

function normalizeSalespersonLabel(s: string | null | undefined): string {
  // Used only when we map Shopify labels to internal salesperson_name values.
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function upsertSetting(
  supabase: ReturnType<typeof createClient>,
  key: string,
  value: string,
) {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

async function refreshWithClientCredentials(
  domain: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresInSec: number }> {
  const url = new URL(`https://${domain}/admin/oauth/access_token`);
  url.searchParams.set("grant_type", "client_credentials");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Shopify token endpoint non-JSON response [${response.status}]`);
  }
  if (!response.ok) {
    throw new Error(
      `Shopify token refresh failed [${response.status}]: ${
        (json.error as string) || (json.errors as string) || text
      }`,
    );
  }

  const accessTokenRaw = String(json.access_token || "");
  const accessToken = normalizeShopifyAdminToken(accessTokenRaw);
  const expiresInRaw = Number(json.expires_in || 0);
  const expiresInSec = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 86400;
  if (!accessToken) throw new Error("Shopify token refresh succeeded but no access_token returned.");
  return { accessToken, expiresInSec };
}

export async function resolveShopifyAuth(
  supabase: ReturnType<typeof createClient>,
  opts: ResolveShopifyAuthOptions = {},
): Promise<ShopifyAuthResult> {
  const { data } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", [
      "shopify_store_domain",
      "shopify_access_token",
      "shopify_access_token_expires_at",
      "shopify_client_id",
      "shopify_client_secret",
    ]);

  const settings = mapSettings(data as SettingRow[] | null);
  const envDomain = Deno.env.get("SHOPIFY_STORE_DOMAIN") || "";
  const envToken = Deno.env.get("SHOPIFY_ACCESS_TOKEN") || "";
  const envClientId = Deno.env.get("SHOPIFY_CLIENT_ID") || "";
  const envClientSecret = Deno.env.get("SHOPIFY_CLIENT_SECRET") || "";

  const domain = normalizeShopifyDomain(opts.overrideDomain || settings.shopify_store_domain || envDomain);
  if (!domain) throw new Error("Shopify store domain missing.");

  const overrideAccessToken = normalizeShopifyAdminToken(opts.overrideAccessToken || "");
  if (overrideAccessToken) {
    return {
      shopDomain: domain,
      accessToken: overrideAccessToken,
      tokenSource: "override",
      expiresAt: null,
    };
  }

  let accessToken = normalizeShopifyAdminToken(settings.shopify_access_token || envToken);
  let expiresAt = (settings.shopify_access_token_expires_at || "").trim() || null;
  const clientId = (opts.overrideClientId || settings.shopify_client_id || envClientId || "").trim();
  const clientSecret = normalizeShopifyAdminToken(
    opts.overrideClientSecret || settings.shopify_client_secret || envClientSecret,
  );

  const canRefresh = Boolean(clientId && clientSecret);
  const needsRefresh = opts.forceRefresh || !accessToken || isExpiryNear(expiresAt);

  if (needsRefresh && canRefresh) {
    const refreshed = await refreshWithClientCredentials(domain, clientId, clientSecret);
    accessToken = refreshed.accessToken;
    const nextExpiresAt = new Date(Date.now() + refreshed.expiresInSec * 1000).toISOString();
    expiresAt = nextExpiresAt;

    await upsertSetting(supabase, "shopify_access_token", accessToken);
    await upsertSetting(supabase, "shopify_access_token_expires_at", nextExpiresAt);
    if (!settings.shopify_client_id && clientId) await upsertSetting(supabase, "shopify_client_id", clientId);
    if (!settings.shopify_client_secret && clientSecret) await upsertSetting(supabase, "shopify_client_secret", clientSecret);

    return { shopDomain: domain, accessToken, tokenSource: "refreshed", expiresAt };
  }

  if (!accessToken) {
    throw new Error(
      "Shopify access token missing and client credentials were not provided. Set shopify_client_id and shopify_client_secret in Settings.",
    );
  }

  return { shopDomain: domain, accessToken, tokenSource: "cached", expiresAt };
}
