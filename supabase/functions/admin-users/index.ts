import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { corsHeaders } from "../_shared/cors.ts";
import { requireAdmin } from "../_shared/require-admin.ts";

const MIN_PASSWORD_LEN = 8;

type AppRole = "admin" | "supervisor" | "manager" | "salesperson";

function jsonErr(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonOk(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const rolePriority: AppRole[] = ["admin", "supervisor", "manager", "salesperson"];

function isValidRole(role: string): role is AppRole {
  return rolePriority.includes(role as AppRole);
}

function pickRoleRow(rows: { role: AppRole; salesperson_name: string | null }[]) {
  if (!rows.length) return null;
  for (const role of rolePriority) {
    const found = rows.find((row) => row.role === role);
    if (found) return found;
  }
  return null;
}

function buildRoleRows(role: AppRole, salespersonName: string | null) {
  if (role === "admin") {
    return [{ role: "admin" as const, salesperson_name: null }];
  }
  if (role === "salesperson") {
    return [{ role: "salesperson" as const, salesperson_name: salespersonName }];
  }
  return [
    { role, salesperson_name: salespersonName },
    { role: "salesperson" as const, salesperson_name: salespersonName },
  ];
}

async function handleList(supabase: SupabaseClient) {
  const { data: rolesData, error: rolesErr } = await supabase
    .from("user_roles")
    .select("id, user_id, role, salesperson_name");
  if (rolesErr) return jsonErr(rolesErr.message, 500);

  const rolesByUser = new Map<string, { role: AppRole; salesperson_name: string | null }[]>();
  for (const r of rolesData || []) {
    const list = rolesByUser.get(r.user_id) || [];
    list.push({ role: r.role as AppRole, salesperson_name: r.salesperson_name });
    rolesByUser.set(r.user_id, list);
  }

  const allUsers: { id: string; email?: string; created_at: string; user_metadata?: Record<string, unknown> }[] = [];
  let page = 1;
  const perPage = 200;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) return jsonErr(error.message, 500);
    const batch = data.users;
    allUsers.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }

  const users = allUsers.map((u) => {
    const rows = rolesByUser.get(u.id) || [];
    const roleRow = pickRoleRow(rows);
    const meta = u.user_metadata || {};
    const full_name = String(meta.full_name || meta.name || "");
    const salespersonRow = rows.find((r) => r.role === "salesperson");
    return {
      id: u.id,
      email: u.email ?? null,
      full_name,
      created_at: u.created_at,
      role: roleRow?.role ?? null,
      salesperson_name: salespersonRow?.salesperson_name ?? roleRow?.salesperson_name ?? null,
      has_role_row: !!roleRow,
    };
  });

  return jsonOk({ users });
}

async function handleCreate(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const full_name = String(body.full_name || "").trim();
  const role = body.role as AppRole;
  let salesperson_name = body.salesperson_name != null ? String(body.salesperson_name).trim() : "";

  if (!email || !email.includes("@")) return jsonErr("A valid email is required", 400);
  if (password.length < MIN_PASSWORD_LEN) {
    return jsonErr(`Password must be at least ${MIN_PASSWORD_LEN} characters`, 400);
  }
  if (!isValidRole(role)) return jsonErr("Invalid role", 400);
  if (role !== "admin" && !salesperson_name) {
    salesperson_name = full_name || email.split("@")[0] || "Salesperson";
  }

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      ...(full_name ? { full_name, name: full_name } : {}),
    },
  });
  if (authError) return jsonErr(authError.message, 400);
  const user = authData.user;
  if (!user) return jsonErr("User creation failed", 500);

  const roleRows = buildRoleRows(role, role === "admin" ? null : salesperson_name);
  const { error: roleErr } = await supabase.from("user_roles").insert(
    roleRows.map((row) => ({
      user_id: user.id,
      role: row.role,
      salesperson_name: row.salesperson_name,
    })),
  );
  if (roleErr) {
    await supabase.auth.admin.deleteUser(user.id);
    return jsonErr(roleErr.message, 500);
  }

  return jsonOk({ success: true, user: { id: user.id, email: user.email } });
}

async function handleUpdate(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  callerId: string,
) {
  const user_id = String(body.user_id || "");
  if (!user_id) return jsonErr("user_id is required", 400);

  const emailRaw = body.email;
  const hasEmail = emailRaw !== undefined && emailRaw !== null && String(emailRaw).trim() !== "";
  const email = hasEmail ? String(emailRaw).trim().toLowerCase() : undefined;
  const password = body.password != null ? String(body.password) : "";
  const hasFullName = body.full_name !== undefined;
  const full_name = hasFullName ? String(body.full_name ?? "").trim() : undefined;
  const roleProvided = body.role !== undefined && body.role !== null && String(body.role).trim() !== "";
  const role = roleProvided ? (String(body.role) as AppRole) : undefined;
  const spProvided = body.salesperson_name !== undefined;
  const salesperson_name_in = spProvided ? String(body.salesperson_name ?? "").trim() : undefined;

  if (email !== undefined && !email.includes("@")) return jsonErr("A valid email is required", 400);
  if (password.length > 0 && password.length < MIN_PASSWORD_LEN) {
    return jsonErr(`Password must be at least ${MIN_PASSWORD_LEN} characters`, 400);
  }

  const { data: existingWrap, error: getErr } = await supabase.auth.admin.getUserById(user_id);
  if (getErr || !existingWrap.user) return jsonErr("User not found", 404);
  const existingUser = existingWrap.user;

  const adminUpdate: {
    email?: string;
    password?: string;
    user_metadata?: Record<string, unknown>;
  } = {};
  if (email !== undefined) adminUpdate.email = email;
  if (password.length > 0) adminUpdate.password = password;

  if (hasFullName) {
    adminUpdate.user_metadata = {
      ...(existingUser.user_metadata || {}),
      full_name: full_name || null,
      name: full_name || null,
    };
  }

  if (Object.keys(adminUpdate).length > 0) {
    const { error } = await supabase.auth.admin.updateUserById(user_id, adminUpdate);
    if (error) return jsonErr(error.message, 400);
  }

  if (role !== undefined) {
    if (!isValidRole(role)) return jsonErr("Invalid role", 400);

    const { data: currentRows } = await supabase.from("user_roles").select("role").eq("user_id", user_id);
    const wasAdmin = currentRows?.some((r) => r.role === "admin");

    if (wasAdmin && role !== "admin" && callerId === user_id) {
      const { count } = await supabase
        .from("user_roles")
        .select("*", { count: "exact", head: true })
        .eq("role", "admin");
      if ((count ?? 0) <= 1) return jsonErr("Cannot demote the only admin", 400);
    }

    let spName: string | null = role === "admin" ? null : (salesperson_name_in ?? "");
    if (role !== "admin" && !spName) {
      const meta = existingUser.user_metadata as Record<string, string | undefined>;
      spName =
        meta?.full_name ||
        meta?.name ||
        existingUser.email?.split("@")[0] ||
        "Salesperson";
    }

    await supabase.from("user_roles").delete().eq("user_id", user_id);
    const roleRows = buildRoleRows(role, spName);
    const { error: insErr } = await supabase.from("user_roles").insert(
      roleRows.map((row) => ({
        user_id,
        role: row.role,
        salesperson_name: row.salesperson_name,
      })),
    );
    if (insErr) return jsonErr(insErr.message, 500);
  } else if (spProvided && salesperson_name_in !== undefined) {
    const { data: rows } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user_id);
    const hasNonAdminRole = !!rows?.some((r) => r.role !== "admin");
    if (!hasNonAdminRole) return jsonErr("User does not have a sales role", 400);
    const { error } = await supabase
      .from("user_roles")
      .update({ salesperson_name: salesperson_name_in || null })
      .eq("user_id", user_id)
      .neq("role", "admin");
    if (error) return jsonErr(error.message, 500);
  }

  return jsonOk({ success: true });
}

async function handleDelete(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  callerId: string,
) {
  const user_id = String(body.user_id || "");
  if (!user_id) return jsonErr("user_id is required", 400);
  if (user_id === callerId) return jsonErr("You cannot delete your own account", 400);

  const { data: rows } = await supabase.from("user_roles").select("role").eq("user_id", user_id);
  const isAdmin = rows?.some((r) => r.role === "admin");
  if (isAdmin) {
    const { count } = await supabase
      .from("user_roles")
      .select("*", { count: "exact", head: true })
      .eq("role", "admin");
    if ((count ?? 0) <= 1) return jsonErr("Cannot delete the only admin user", 400);
  }

  const { error } = await supabase.auth.admin.deleteUser(user_id);
  if (error) return jsonErr(error.message, 400);
  return jsonOk({ success: true });
}

async function handleListHierarchy(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("sales_hierarchy_edges")
    .select("leader_user_id, member_user_id, leader_role");
  if (error) return jsonErr(error.message, 500);
  return jsonOk({ edges: data ?? [] });
}

async function userHasRole(supabase: SupabaseClient, userId: string, role: AppRole) {
  const { data } = await supabase
    .from("user_roles")
    .select("user_id")
    .eq("user_id", userId)
    .eq("role", role)
    .maybeSingle();
  return !!data;
}

async function handleSaveHierarchy(supabase: SupabaseClient, body: Record<string, unknown>) {
  const memberUserId = String(body.member_user_id || "");
  const managerUserId = body.manager_user_id ? String(body.manager_user_id) : "";
  const supervisorUserId = body.supervisor_user_id ? String(body.supervisor_user_id) : "";

  if (!memberUserId) return jsonErr("member_user_id is required", 400);
  if (managerUserId && managerUserId === memberUserId) return jsonErr("Manager cannot be the same user", 400);
  if (supervisorUserId && supervisorUserId === memberUserId) return jsonErr("Supervisor cannot be the same user", 400);
  if (managerUserId && supervisorUserId && managerUserId === supervisorUserId) {
    return jsonErr("Manager and supervisor must be different users", 400);
  }

  const memberIsSales = await userHasRole(supabase, memberUserId, "salesperson");
  if (!memberIsSales) return jsonErr("Target user must have salesperson role", 400);

  if (managerUserId) {
    const managerIsManager = await userHasRole(supabase, managerUserId, "manager");
    if (!managerIsManager) return jsonErr("Selected manager does not have manager role", 400);
  }
  if (supervisorUserId) {
    const supervisorIsSupervisor = await userHasRole(supabase, supervisorUserId, "supervisor");
    if (!supervisorIsSupervisor) return jsonErr("Selected supervisor does not have supervisor role", 400);
  }

  await supabase
    .from("sales_hierarchy_edges")
    .delete()
    .eq("member_user_id", memberUserId)
    .eq("leader_role", "manager");

  await supabase
    .from("sales_hierarchy_edges")
    .delete()
    .eq("member_user_id", memberUserId)
    .eq("leader_role", "supervisor");

  const rows: { leader_user_id: string; member_user_id: string; leader_role: "manager" | "supervisor" }[] = [];
  if (managerUserId) rows.push({ leader_user_id: managerUserId, member_user_id: memberUserId, leader_role: "manager" });
  if (supervisorUserId) rows.push({ leader_user_id: supervisorUserId, member_user_id: memberUserId, leader_role: "supervisor" });

  if (rows.length) {
    const { error } = await supabase.from("sales_hierarchy_edges").insert(rows);
    if (error) return jsonErr(error.message, 500);
  }

  return jsonOk({ success: true });
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return jsonErr("Method not allowed", 405);
    }

    const denied = await requireAdmin(req, corsHeaders);
    if (denied) return denied;

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON) {
      return jsonErr("Server misconfigured", 500);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonErr("Invalid JSON body", 400);
    }

    const action = String(body.action || "");
    const authHeader = req.headers.get("Authorization") || "";
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: callerErr } = await anonClient.auth.getUser();
    if (callerErr || !caller) return jsonErr("Unauthorized", 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    switch (action) {
      case "list":
        return await handleList(supabase);
      case "create":
        return await handleCreate(supabase, body);
      case "update":
        return await handleUpdate(supabase, body, caller.id);
      case "delete":
        return await handleDelete(supabase, body, caller.id);
      case "list_hierarchy":
        return await handleListHierarchy(supabase);
      case "save_hierarchy":
        return await handleSaveHierarchy(supabase, body);
      default:
        return jsonErr('Unknown action. Use "list", "create", "update", "delete", "list_hierarchy", or "save_hierarchy".', 400);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Server error";
    return jsonErr(msg, 500);
  }
});
