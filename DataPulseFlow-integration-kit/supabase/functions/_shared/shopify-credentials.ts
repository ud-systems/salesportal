/** Must match Shopify Admin GraphQL version used across edge functions. */
export const SHOPIFY_ADMIN_API_VERSION = "2025-01";

/** e.g. `https://shop.myshopify.com/path` → `shop.myshopify.com` */
export function normalizeShopifyDomain(raw: string): string {
  let d = (raw || "").trim();
  d = d.replace(/^["']|["']$/g, "");
  d = d.replace(/^https?:\/\//i, "");
  d = d.split("/")[0]?.split(":")[0] || "";
  return d.toLowerCase();
}

/**
 * Trim whitespace; strip wrapping quotes; remove spaces/newlines (paste errors);
 * strip BOM and zero-width chars (common when copying from Shopify / PDF / Teams).
 */
export function normalizeShopifyAdminToken(raw: string): string {
  let t = (raw || "").trim();
  t = t.replace(/^\uFEFF/, "");
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = t.replace(/^["']|["']$/g, "");
  return t.replace(/\s+/g, "");
}

/** Custom-app Admin API access tokens are `shpat_` + secret (legacy private apps differ — we only support custom app flow here). */
export function looksLikeShopifyCustomAppAdminToken(token: string): boolean {
  return /^shpat_[a-zA-Z0-9_-]{20,}$/.test(token);
}

export function shopifyAdminGraphqlUrl(domain: string): string {
  const host = normalizeShopifyDomain(domain);
  return `https://${host}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;
}
