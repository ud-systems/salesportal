import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: "Missing Supabase credentials" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const users = [
    { email: "admin@udsales.com", password: "admin123!", role: "admin" as const, name: "James Carter", salesperson_name: null },
    { email: "sarah@udsales.com", password: "sales123!", role: "salesperson" as const, name: "Sarah Mitchell", salesperson_name: "Sarah Mitchell" },
    { email: "ahmed@udsales.com", password: "sales123!", role: "salesperson" as const, name: "Ahmed Khan", salesperson_name: "Ahmed Khan" },
  ];

  const results = [];

  for (const u of users) {
    try {
      // Create user via admin API
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: u.email,
        password: u.password,
        email_confirm: true,
        user_metadata: { full_name: u.name },
      });

      if (authError) {
        // User might already exist
        if (authError.message.includes("already")) {
          results.push({ email: u.email, status: "already_exists" });
          continue;
        }
        results.push({ email: u.email, status: "error", error: authError.message });
        continue;
      }

      // Assign role
      if (authData.user) {
        await supabase.from("user_roles").upsert({
          user_id: authData.user.id,
          role: u.role,
          salesperson_name: u.salesperson_name,
        }, { onConflict: "user_id,role" });
      }

      results.push({ email: u.email, status: "created", role: u.role });
    } catch (err) {
      results.push({ email: u.email, status: "error", error: err instanceof Error ? err.message : "Unknown" });
    }
  }

  return new Response(JSON.stringify({ success: true, results }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
