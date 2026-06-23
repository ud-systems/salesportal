import { getSupabaseAuthStorageKey } from "@/lib/supabase-url";

const STORAGE_KEY = getSupabaseAuthStorageKey();

/** Remove corrupt or empty auth blobs after sign-out (avoids refresh-token retry loops). */
export function purgeCorruptAuthStorageIfSignedOut() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { refresh_token?: string | null } | null;
    const refreshToken = parsed?.refresh_token;
    if (refreshToken === null || refreshToken === undefined || refreshToken === "") {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}
