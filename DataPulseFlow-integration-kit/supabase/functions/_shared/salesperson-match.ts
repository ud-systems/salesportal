/**
 * Match Shopify customer metafield labels (SP / referred-by) to `user_roles.salesperson_name`.
 *
 * Designed for Shopify choice-list values (e.g. `custom.referredby`) matching Settings → Salespersons
 * (`user_roles.salesperson_name`) character-for-character aside from case/punctuation.
 * Also handles tag-style names without spaces (e.g. "RobLister" vs "Rob Lister").
 */

/** Read metafields in this order so `custom.referredby` wins over another namespace’s `referredby`. */
export const REFERRED_BY_METAFIELD_KEYS_ORDERED = [
  "custom.referredby",
  "custom.referred_by",
  "referredby",
  "referred_by",
  "referrer",
  "custom.referrer",
] as const;

/** SP metafield keys — `custom.*` first to align with Shopify customer metafield definitions. */
export const SP_ASSIGNED_METAFIELD_KEYS_ORDERED = [
  "custom.sp_assigned",
  "custom.sp_assigned_customer",
  "custom.salesperson",
  "sp_assigned",
  "sp_assigned_customer",
  "salesperson",
  "custom.sales_person",
] as const;

const NO_REFERRAL_NORMALIZED = new Set([
  "no referrer",
  "none",
  "n a",
  "na",
  "not applicable",
  "no referral",
  "no ref",
]);

export function normalizeSalespersonLabel(s: string | null | undefined): string {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Letters/digits only — "rob lister" and "roblister" both become "roblister". */
export function normalizeSalespersonCompact(s: string | null | undefined): string {
  return normalizeSalespersonLabel(s).replace(/\s/g, "");
}

export function stripReferralPrefix(value: string): string {
  return value
    .trim()
    .replace(/^referred\s*by\s*:\s*/i, "")
    .trim();
}

/** Choice-list value means “no salesperson referral” — do not infer or assign from it. */
export function isShopifyNoReferralChoice(value: string | null | undefined): boolean {
  const n = normalizeSalespersonLabel(stripReferralPrefix(value || ""));
  if (!n) return true;
  return NO_REFERRAL_NORMALIZED.has(n);
}

/**
 * Pick first non-empty metafield value following priority order.
 * Use `spec` either as bare key (`referredby`) or `namespace.key` (`custom.referredby`).
 */
export function metafieldValueForKeysOrdered(
  metafields: { namespace?: string; key: string; value: string }[],
  keysInPriorityOrder: readonly string[],
): string | null {
  for (const spec of keysInPriorityOrder) {
    const want = spec.toLowerCase().trim();
    if (!want) continue;
    const hit = metafields.find((m) => {
      const key = (m.key || "").toLowerCase();
      const ns = (m.namespace || "").toLowerCase();
      if (want.includes(".")) {
        return `${ns}.${key}` === want;
      }
      return key === want;
    });
    const v = hit?.value?.trim();
    if (v) return v;
  }
  return null;
}

/**
 * True if Shopify-side text refers to the same person as `salesperson_name` in user_roles.
 */
export function labelsMatchShopifyToRole(shopifyLabel: string, roleName: string | null | undefined): boolean {
  const cleaned = stripReferralPrefix(shopifyLabel).trim();
  if (!cleaned) return false;
  const a = normalizeSalespersonLabel(cleaned);
  const b = normalizeSalespersonLabel(roleName);
  if (!b || a === "unassigned") return false;
  if (a === b) return true;
  const ca = normalizeSalespersonCompact(cleaned);
  const cb = normalizeSalespersonCompact(roleName);
  return ca.length >= 2 && cb.length >= 2 && ca === cb;
}

export function findSalespersonRow(
  salespeople: { user_id: string; salesperson_name: string | null }[],
  shopifyDisplayLabel: string | null | undefined,
): { user_id: string; salesperson_name: string | null } | undefined {
  const raw = (shopifyDisplayLabel || "").trim();
  if (!raw || isShopifyNoReferralChoice(raw)) return undefined;
  for (const sp of salespeople) {
    if (labelsMatchShopifyToRole(raw, sp.salesperson_name)) return sp;
  }
  return undefined;
}

/** Unordered match (legacy); prefer `metafieldValueForKeysOrdered` for customer metafields. */
export function metafieldByKeys(
  metafields: { namespace?: string; key: string; value: string }[],
  keys: string[],
): string | null {
  const wantKeys = new Set(keys.map((k) => k.toLowerCase()));
  const hit = metafields.find((m) => {
    const key = m.key.toLowerCase();
    if (wantKeys.has(key)) return true;
    const ns = (m.namespace || "").toLowerCase();
    if (ns && wantKeys.has(`${ns}.${key}`)) return true;
    return false;
  });
  return hit?.value ?? null;
}
