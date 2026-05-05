import { supabase } from "@/integrations/supabase/client";

/**
 * Supabase Edge Functions gateway validates JWT strictly. A stale access_token
 * still returned by getSession() often yields 401 while PostgREST may keep working.
 * Refresh only when the JWT is near expiry, and dedupe concurrent refreshes so we
 * do not fight the auth client's navigator lock (see gotrue NavigatorLockAcquireTimeoutError).
 */
let edgeTokenRefreshInFlight: Promise<string | null> | null = null;

function jwtExpMs(accessToken: string): number | null {
  try {
    const segment = accessToken.split(".")[1];
    if (!segment) return null;
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function getAccessTokenForEdgeFunctions(): Promise<string | null> {
  if (edgeTokenRefreshInFlight) return edgeTokenRefreshInFlight;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return null;

  const expMs = jwtExpMs(session.access_token);
  const skewMs = 120_000;
  if (expMs != null && expMs > Date.now() + skewMs) {
    return session.access_token;
  }

  if (edgeTokenRefreshInFlight) return edgeTokenRefreshInFlight;

  const fallbackToken = session.access_token;

  edgeTokenRefreshInFlight = (async () => {
    try {
      const { data, error } = await supabase.auth.refreshSession();
      if (!error && data.session?.access_token) {
        return data.session.access_token;
      }
      if (error && /Invalid Refresh Token|Refresh Token Not Found/i.test(error.message || "")) {
        await supabase.auth.signOut({ scope: "local" });
        return null;
      }
      return fallbackToken;
    } finally {
      edgeTokenRefreshInFlight = null;
    }
  })();

  return edgeTokenRefreshInFlight;
}
