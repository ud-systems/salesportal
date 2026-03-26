import { supabase } from "@/integrations/supabase/client";

/**
 * Supabase Edge Functions gateway validates JWT strictly. A stale access_token
 * still returned by getSession() often yields 401 while PostgREST may keep working.
 * Refresh the session first, then return a token for Authorization: Bearer …
 */
export async function getAccessTokenForEdgeFunctions(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return null;

  const { data, error } = await supabase.auth.refreshSession();
  if (!error && data.session?.access_token) {
    return data.session.access_token;
  }

  return session.access_token;
}
