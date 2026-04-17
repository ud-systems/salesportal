import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";
import { resolveCapabilities, type AppCapability } from "@/lib/auth-capabilities";

export type UserRole = "admin" | "supervisor" | "manager" | "salesperson";

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  roles: UserRole[];
  initials: string;
  salesperson_name?: string;
  /** False when no `user_roles` row exists — RLS will not grant salesperson data until an admin provisions the account. */
  hasDbRole: boolean;
}

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
  capabilities: AppCapability[];
  hasCapability: (capability: AppCapability) => boolean;
  isAdmin: boolean;
  isSupervisor: boolean;
  isManager: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

function getInitials(email: string, name?: string): string {
  if (name) {
    return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
  }
  return email.slice(0, 2).toUpperCase();
}

const rolePriority: UserRole[] = ["admin", "supervisor", "manager", "salesperson"];

function pickPrimaryRole(roles: UserRole[]): UserRole {
  for (const role of rolePriority) {
    if (roles.includes(role)) return role;
  }
  return "salesperson";
}

async function fetchUserRole(userId: string): Promise<{ role: UserRole; roles: UserRole[]; salesperson_name?: string } | null> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role, salesperson_name")
    .eq("user_id", userId)
    .returns<{ role: UserRole; salesperson_name: string | null }[]>();
  if (error || !data) return null;
  const roles = Array.from(new Set(data.map((row) => row.role)));
  if (!roles.length) return null;
  const salespersonRow = data.find((row) => row.role === "salesperson");
  return {
    role: pickPrimaryRole(roles),
    roles,
    salesperson_name: salespersonRow?.salesperson_name || undefined,
  };
}

function buildAppUser(authUser: User, role: UserRole, opts?: { roles?: UserRole[]; salesperson_name?: string; hasDbRole?: boolean }): AppUser {
  const email = authUser.email || "";
  const salesperson_name = opts?.salesperson_name;
  const name = authUser.user_metadata?.full_name || authUser.user_metadata?.name || salesperson_name || email.split("@")[0];
  return {
    id: authUser.id,
    name,
    email,
    role,
    roles: opts?.roles?.length ? opts.roles : [role],
    initials: getInitials(email, name),
    salesperson_name,
    hasDbRole: opts?.hasDbRole ?? true,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const applySession = async (session: { user: User } | null) => {
      if (session?.user) {
        const roleData = await fetchUserRole(session.user.id);
        if (roleData) {
          setUser(
            buildAppUser(session.user, roleData.role, {
              roles: roleData.roles,
              salesperson_name: roleData.salesperson_name,
              hasDbRole: true,
            }),
          );
        } else {
          setUser(buildAppUser(session.user, "salesperson", { hasDbRole: false }));
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    };
    const handleInvalidRefreshToken = async (message: string) => {
      if (!/Invalid Refresh Token|Refresh Token Not Found/i.test(message)) return;
      // Clear only local auth state, avoid noisy retry loops with stale tokens.
      await supabase.auth.signOut({ scope: "local" });
      setUser(null);
      setLoading(false);
    };

    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session as { user: User } | null);
    });

    // Then check existing session
    supabase.auth.getSession()
      .then(async ({ data: { session }, error }) => {
        if (error) {
          await handleInvalidRefreshToken(error.message);
          return;
        }
        await applySession(session as { user: User } | null);
      })
      .catch(async (err) => {
        await handleInvalidRefreshToken(err instanceof Error ? err.message : String(err));
      });

    return () => subscription.unsubscribe();
  }, []);

  const login = async (email: string, password: string): Promise<string | null> => {
    const normalizedEmail = email.trim().toLowerCase();
    const { error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
    if (error) return error.message;
    return null;
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  const capabilities = user ? resolveCapabilities(user.roles) : [];
  const hasCapability = (capability: AppCapability) => capabilities.includes(capability);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        logout,
        capabilities,
        hasCapability,
        isAdmin: user?.roles.includes("admin") ?? false,
        isSupervisor: user?.roles.includes("supervisor") ?? false,
        isManager: user?.roles.includes("manager") ?? false,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
