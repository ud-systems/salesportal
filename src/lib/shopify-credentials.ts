/** Match edge function normalization before Test Connection / save. */

export function normalizeShopifyDomainClient(raw: string): string {
  let d = (raw || "").trim();
  d = d.replace(/^["']|["']$/g, "");
  d = d.replace(/^https?:\/\//i, "");
  d = d.split("/")[0]?.split(":")[0] || "";
  return d.toLowerCase();
}

export function normalizeShopifyAdminTokenClient(raw: string): string {
  let t = (raw || "").trim();
  t = t.replace(/^\uFEFF/, "");
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = t.replace(/^["']|["']$/g, "");
  return t.replace(/\s+/g, "");
}

export function parseEdgeFunctionErrorPayload(
  data: unknown,
  error: unknown,
): string | null {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.error === "string" && d.error) return d.error;
    if (typeof d.errors === "string" && d.errors) return d.errors;
  }
  if (error && typeof error === "object") {
    const e = error as { message?: string; context?: { body?: string } };
    if (e.context?.body) {
      try {
        const b = JSON.parse(e.context.body) as Record<string, unknown>;
        if (typeof b.error === "string" && b.error) return b.error;
        if (typeof b.errors === "string" && b.errors) return b.errors;
      } catch {
        /* ignore */
      }
    }
    if (typeof e.message === "string") return e.message;
  }
  return null;
}
