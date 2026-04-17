/** CORS for browser calls from the Vite app (localhost + production). */
const configuredOrigin = (Deno.env.get("ALLOWED_ORIGIN") || Deno.env.get("APP_ORIGIN") || "").trim();

export const corsHeaders: Record<string, string> = {
  // Default remains permissive for backwards compatibility; set ALLOWED_ORIGIN in production.
  "Access-Control-Allow-Origin": configuredOrigin || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Max-Age": "86400",
};
