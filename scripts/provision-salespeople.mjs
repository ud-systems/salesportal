/**
 * One-off: create Auth users + user_roles (salesperson) for the UD team.
 * Requires: npx supabase login, and CLI access to the project.
 * Usage: node scripts/provision-salespeople.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";

const PROJECT_REF = "xbmpndatdanjewhwxzxr";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const PASSWORD = "P@SSword";

/** Display names must match Shopify "Referred by" choice list (spacing/case normalized on match). */
const SALESPEOPLE = [
  { salesperson_name: "Adam Fysal", email: "adam.fysal@uniquedistribution.com" },
  { salesperson_name: "Adam Yousuf", email: "adam@uniquedistribution.com" },
  { salesperson_name: "Drew Murray", email: "drew.murray@uniquedistribution.com" },
  { salesperson_name: "Jake Dodd", email: "jake.dodd@uniquedistribution.com" },
  { salesperson_name: "John Yates", email: "john.yates@uniquedistribution.com" },
  { salesperson_name: "Karanjot Bassi", email: "karanjot.bassi@uniquedistribution.com" },
  { salesperson_name: "Kulwant Singh", email: "kulwantsingh@uniquedistribution.com" },
  { salesperson_name: "Mahendra Badsiwal", email: "mahendra.badsiwal@uniquedistribution.com" },
  { salesperson_name: "Nash Shakti", email: "nash.shakti@uniquedistribution.com" },
  { salesperson_name: "Rob Lister", email: "rob@uniquedistribution.com" },
  { salesperson_name: "Simon Hartshorn", email: "simon.hartshorn@uniquedistribution.com" },
  { salesperson_name: "Tauqir Ashfaq", email: "tauqir.ashfaq@uniquedistribution.com" },
  { salesperson_name: "Tom Cook", email: "tom.cook@uniquedistribution.com" },
];

function getServiceRoleKey() {
  const raw = execSync(`npx supabase projects api-keys --project-ref ${PROJECT_REF} -o json`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const keys = JSON.parse(raw);
  const legacy = keys.find((k) => k.id === "service_role" || k.name === "service_role");
  if (!legacy?.api_key) throw new Error("Could not resolve service_role key from Supabase CLI.");
  return legacy.api_key;
}

async function findUserIdByEmail(admin, email) {
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await admin.listUsers({ page, perPage });
    if (error) throw error;
    const u = data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    if (u) return u.id;
    if (data.users.length < perPage) break;
    page++;
  }
  return null;
}

async function main() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || getServiceRoleKey();
  const supabase = createClient(SUPABASE_URL, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const results = [];

  for (const row of SALESPEOPLE) {
    const email = row.email.trim().toLowerCase();
    const displayName = row.salesperson_name.trim();

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: displayName },
    });

    let userId = created?.user?.id ?? null;

    if (createErr) {
      const msg = createErr.message || "";
      if (/already|exists|registered/i.test(msg)) {
        userId = await findUserIdByEmail(supabase.auth.admin, email);
        if (!userId) {
          results.push({ email, status: "error", detail: "User exists but could not list id" });
          continue;
        }
        results.push({ email, status: "existing_user", userId });
      } else {
        results.push({ email, status: "error", detail: msg });
        continue;
      }
    } else {
      results.push({ email, status: "created", userId });
    }

    const { error: roleErr } = await supabase.from("user_roles").upsert(
      {
        user_id: userId,
        role: "salesperson",
        salesperson_name: displayName,
      },
      { onConflict: "user_id,role" },
    );

    if (roleErr) {
      results.push({ email, status: "role_error", detail: roleErr.message });
    }
  }

  console.log(JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.status === "error" || r.status === "role_error");
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
