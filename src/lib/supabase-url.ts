/** Supabase project ref (e.g. xbmpndatdanjewhwxzxr) — used for auth storage key, not request URLs. */
export function getSupabaseProjectRef(): string {
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (!url) return "";
  try {
    return new URL(url).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * Browser Supabase API base URL. Proxied through same-origin `/api/db` so DevTools
 * does not expose the raw *.supabase.co host to end users.
 */
export function getSupabaseBrowserUrl(): string {
  if (typeof window === "undefined") {
    return import.meta.env.VITE_SUPABASE_URL;
  }
  return `${window.location.origin}/api/db`;
}

export function getSupabaseAuthStorageKey(): string {
  return `sb-${getSupabaseProjectRef()}-auth-token`;
}
