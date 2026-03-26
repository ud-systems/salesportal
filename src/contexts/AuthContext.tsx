import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";

export type UserRole = "admin" | "salesperson";

export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
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
  isAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

function getInitials(email: string, name?: string): string {
  if (name) {
    return name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);
  }
  return email.slice(0, 2).toUpperCase();
}

async function fetchUserRole(userId: string): Promise<{ role: UserRole; salesperson_name?: string } | null> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role, salesperson_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return { role: data.role as UserRole, salesperson_name: data.salesperson_name || undefined };
}

function buildAppUser(authUser: User, role: UserRole, opts?: { salesperson_name?: string; hasDbRole?: boolean }): AppUser {
  const email = authUser.email || "";
  const salesperson_name = opts?.salesperson_name;
  const name = authUser.user_metadata?.full_name || authUser.user_metadata?.name || salesperson_name || email.split("@")[0];
  return {
    id: authUser.id,
    name,
    email,
    role,
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

    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      void applySession(session as { user: User } | null);
    });

    // Then check existing session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      await applySession(session as { user: User } | null);
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

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, isAdmin: user?.role === "admin" }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
