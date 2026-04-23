import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAccessTokenForEdgeFunctions } from "@/lib/supabase-edge-auth";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BottomSheet } from "@/components/BottomSheet";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2, UserCog, Eye, EyeOff, Network } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { parseEdgeFunctionErrorPayload } from "@/lib/shopify-credentials";

export type ListedAppUser = {
  id: string;
  email: string | null;
  full_name: string;
  created_at: string;
  role: "admin" | "owner" | "supervisor" | "manager" | "salesperson" | null;
  salesperson_name: string | null;
  has_role_row: boolean;
};

const MIN_PASSWORD_LEN = 8;

function useIsMdUp() {
  const [mdUp, setMdUp] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)").matches : true,
  );
  useEffect(() => {
    const m = window.matchMedia("(min-width: 768px)");
    const fn = () => setMdUp(m.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);
  return mdUp;
}

async function invokeAdminUsers<T>(body: Record<string, unknown>): Promise<T> {
  const accessToken = await getAccessTokenForEdgeFunctions();
  if (!accessToken) {
    throw new Error("Your session expired. Please sign in again.");
  }
  const { data, error } = await supabase.functions.invoke("admin-users", {
    body,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const parsed = parseEdgeFunctionErrorPayload(data, error);
  if (parsed) throw new Error(parsed);
  return data as T;
}

type FormState = {
  email: string;
  password: string;
  full_name: string;
  role: "admin" | "owner" | "supervisor" | "manager" | "salesperson";
  salesperson_name: string;
};

type HierarchyEdge = {
  leader_user_id: string;
  member_user_id: string;
  leader_role: "manager" | "supervisor";
};

type HierarchySelection = {
  manager_user_id: string;
  supervisor_user_id: string;
};

const emptyForm = (): FormState => ({
  email: "",
  password: "",
  full_name: "",
  role: "salesperson",
  salesperson_name: "",
});

function isAdminLevelRole(role: ListedAppUser["role"] | FormState["role"]) {
  return role === "admin" || role === "owner";
}

export function SettingsUserManagement() {
  const { user: currentUser } = useAuth();
  const mdUp = useIsMdUp();
  const [users, setUsers] = useState<ListedAppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit">("create");
  const [editing, setEditing] = useState<ListedAppUser | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ListedAppUser | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [hierarchy, setHierarchy] = useState<Record<string, HierarchySelection>>({});
  const [savingHierarchyFor, setSavingHierarchyFor] = useState<string | null>(null);
  const [hierarchyLoading, setHierarchyLoading] = useState(true);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await invokeAdminUsers<{ users: ListedAppUser[] }>({ action: "list" });
      setUsers(res.users || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load users");
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const loadHierarchy = useCallback(async () => {
    setHierarchyLoading(true);
    try {
      const res = await invokeAdminUsers<{ edges: HierarchyEdge[] }>({ action: "list_hierarchy" });
      const next: Record<string, HierarchySelection> = {};
      for (const edge of res.edges || []) {
        const cur = next[edge.member_user_id] || { manager_user_id: "", supervisor_user_id: "" };
        if (edge.leader_role === "manager") cur.manager_user_id = edge.leader_user_id;
        if (edge.leader_role === "supervisor") cur.supervisor_user_id = edge.leader_user_id;
        next[edge.member_user_id] = cur;
      }
      setHierarchy(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load hierarchy assignments");
      setHierarchy({});
    } finally {
      setHierarchyLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHierarchy();
  }, [loadHierarchy]);

  function openCreate() {
    setFormMode("create");
    setEditing(null);
    setForm(emptyForm());
    setShowPassword(false);
    setFormOpen(true);
  }

  function openEdit(u: ListedAppUser) {
    setFormMode("edit");
    setEditing(u);
    setForm({
      email: u.email || "",
      password: "",
      full_name: u.full_name || "",
      role: u.role || "salesperson",
      salesperson_name: u.salesperson_name || "",
    });
    setShowPassword(false);
    setFormOpen(true);
  }

  function validateForm(): string | null {
    const email = form.email.trim();
    if (!email || !email.includes("@")) return "Enter a valid email address.";
    if (formMode === "create") {
      if (form.password.length < MIN_PASSWORD_LEN) {
        return `Password must be at least ${MIN_PASSWORD_LEN} characters.`;
      }
    } else if (form.password.length > 0 && form.password.length < MIN_PASSWORD_LEN) {
      return `New password must be at least ${MIN_PASSWORD_LEN} characters.`;
    }
    if (!isAdminLevelRole(form.role) && !form.salesperson_name.trim()) {
      return "Salesperson display name is required for non-admin accounts (used for Shopify assignment matching).";
    }
    return null;
  }

  async function submitForm() {
    const err = validateForm();
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    try {
      if (formMode === "create") {
        await invokeAdminUsers({
          action: "create",
          email: form.email.trim(),
          password: form.password,
          full_name: form.full_name.trim(),
          role: form.role,
          salesperson_name: isAdminLevelRole(form.role) ? "" : form.salesperson_name.trim(),
        });
        toast.success("User created");
      } else if (editing) {
        const payload: Record<string, unknown> = {
          action: "update",
          user_id: editing.id,
          email: form.email.trim(),
          full_name: form.full_name.trim(),
        };
        if (form.password.trim()) payload.password = form.password;
        if (editing.role !== form.role) {
          payload.role = form.role;
          if (!isAdminLevelRole(form.role)) payload.salesperson_name = form.salesperson_name.trim();
        } else if (!isAdminLevelRole(form.role) && form.salesperson_name.trim() !== (editing.salesperson_name || "")) {
          payload.salesperson_name = form.salesperson_name.trim();
        }
        await invokeAdminUsers(payload);
        toast.success("User updated");
      }
      setFormOpen(false);
      await loadUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await invokeAdminUsers({ action: "delete", user_id: deleteTarget.id });
      toast.success("User removed");
      setDeleteTarget(null);
      await loadUsers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  async function saveHierarchy(memberUserId: string) {
    const row = hierarchy[memberUserId] || { manager_user_id: "", supervisor_user_id: "" };
    if (row.manager_user_id && row.manager_user_id === memberUserId) {
      toast.error("Manager cannot be the same user.");
      return;
    }
    if (row.supervisor_user_id && row.supervisor_user_id === memberUserId) {
      toast.error("Supervisor cannot be the same user.");
      return;
    }
    if (row.manager_user_id && row.supervisor_user_id && row.manager_user_id === row.supervisor_user_id) {
      toast.error("Manager and supervisor must be different users.");
      return;
    }
    setSavingHierarchyFor(memberUserId);
    try {
      await invokeAdminUsers({
        action: "save_hierarchy",
        member_user_id: memberUserId,
        manager_user_id: row.manager_user_id || null,
        supervisor_user_id: row.supervisor_user_id || null,
      });
      toast.success("Hierarchy assignment saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save hierarchy assignment");
    } finally {
      setSavingHierarchyFor(null);
    }
  }

  const formFields = (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="um-email">Email</Label>
        <Input
          id="um-email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          disabled={saving}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="um-password">{formMode === "create" ? "Password" : "New password (optional)"}</Label>
        <div className="relative">
          <Input
            id="um-password"
            type={showPassword ? "text" : "password"}
            autoComplete={formMode === "create" ? "new-password" : "new-password"}
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            disabled={saving}
            className="pr-10"
            placeholder={formMode === "edit" ? "Leave blank to keep current" : ""}
          />
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="um-name">Display name</Label>
        <Input
          id="um-name"
          value={form.full_name}
          onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
          disabled={saving}
          placeholder="Full name"
        />
      </div>
      <div className="space-y-2">
        <Label>Role</Label>
        <Select
          value={form.role}
          onValueChange={(v) => setForm((f) => ({ ...f, role: v as "admin" | "owner" | "supervisor" | "manager" | "salesperson" }))}
          disabled={saving}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="owner">Owner</SelectItem>
            <SelectItem value="supervisor">Supervisor</SelectItem>
            <SelectItem value="manager">Manager</SelectItem>
            <SelectItem value="salesperson">Salesperson</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {!isAdminLevelRole(form.role) && (
        <div className="space-y-2">
          <Label htmlFor="um-sp">Salesperson label</Label>
          <Input
            id="um-sp"
            value={form.salesperson_name}
            onChange={(e) => setForm((f) => ({ ...f, salesperson_name: e.target.value }))}
            disabled={saving}
            placeholder="Must match Shopify SP / referred-by text"
          />
          <p className="text-xs text-muted-foreground font-body">
            This label is matched against customer metafields when syncing from Shopify.
          </p>
        </div>
      )}
    </div>
  );

  const formFooter = (
    <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end w-full">
      <Button type="button" variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
        Cancel
      </Button>
      <Button type="button" onClick={() => void submitForm()} disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
        {formMode === "create" ? "Create user" : "Save changes"}
      </Button>
    </div>
  );

  const managerOptions = users.filter((u) => u.role === "manager");
  const supervisorOptions = users.filter((u) => u.role === "supervisor");
  const memberOptions = users.filter((u) => !isAdminLevelRole(u.role));

  return (
    <div className="space-y-6">
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <UserCog className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">User management</CardTitle>
              <CardDescription>Create accounts, set roles and passwords, and remove users.</CardDescription>
            </div>
          </div>
          <Button onClick={openCreate} className="w-full sm:w-auto shrink-0 tap-scale">
            <Plus className="h-4 w-4 mr-2" />
            Add user
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ) : users.length === 0 ? (
          <p className="text-sm text-muted-foreground font-body">No users returned from Auth.</p>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm font-body">
                <thead>
                  <tr className="border-b bg-muted/40 text-muted-foreground">
                    <th className="text-left py-2.5 px-3 font-medium">User</th>
                    <th className="text-left py-2.5 px-3 font-medium">Role</th>
                    <th className="text-left py-2.5 px-3 font-medium">SP label</th>
                    <th className="text-left py-2.5 px-3 font-medium">Created</th>
                    <th className="text-right py-2.5 px-3 font-medium w-[120px]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="py-3 px-3">
                        <p className="font-medium text-foreground">{u.full_name || "—"}</p>
                        <p className="text-xs text-muted-foreground">{u.email}</p>
                        {!u.has_role_row && (
                          <span className="inline-block mt-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-warning/15 text-warning">
                            No role assigned
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 capitalize">{u.role || "—"}</td>
                      <td className="py-3 px-3 text-muted-foreground">{u.salesperson_name || "—"}</td>
                      <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">
                        {new Date(u.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-3 px-3 text-right">
                        <div className="flex justify-end gap-1">
                          <Button type="button" variant="ghost" size="icon" className="h-9 w-9" onClick={() => openEdit(u)} aria-label={`Edit ${u.email}`}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 text-destructive hover:text-destructive"
                            disabled={u.id === currentUser?.id}
                            onClick={() => setDeleteTarget(u)}
                            aria-label={`Delete ${u.email}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="md:hidden space-y-3">
              {users.map((u) => (
                <div key={u.id} className="rounded-xl border border-border p-4 space-y-3">
                  <div>
                    <p className="font-medium text-foreground">{u.full_name || "—"}</p>
                    <p className="text-xs text-muted-foreground break-all">{u.email}</p>
                    {!u.has_role_row && (
                      <span className="inline-block mt-2 text-[10px] font-medium px-2 py-0.5 rounded-full bg-warning/15 text-warning">
                        No role assigned
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs font-body">
                    <span className={cn("px-2 py-1 rounded-lg bg-muted", isAdminLevelRole(u.role) && "bg-primary/10 text-primary")}>
                      {u.role || "No role"}
                    </span>
                    {u.salesperson_name && (
                      <span className="px-2 py-1 rounded-lg bg-muted text-muted-foreground">SP: {u.salesperson_name}</span>
                    )}
                    <span className="text-muted-foreground">{new Date(u.created_at).toLocaleDateString()}</span>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <Button type="button" variant="outline" size="sm" onClick={() => openEdit(u)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-destructive border-destructive/30"
                      disabled={u.id === currentUser?.id}
                      onClick={() => setDeleteTarget(u)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>

      {mdUp ? (
        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent className="gap-3 p-4 sm:max-w-md max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{formMode === "create" ? "New user" : "Edit user"}</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground font-body">
                Manage account details, role assignment, and salesperson display identity.
              </DialogDescription>
            </DialogHeader>
            {formFields}
            <DialogFooter className="gap-2 sm:gap-0">{formFooter}</DialogFooter>
          </DialogContent>
        </Dialog>
      ) : (
        <BottomSheet
          open={formOpen}
          onClose={() => !saving && setFormOpen(false)}
          title={formMode === "create" ? "New user" : "Edit user"}
          footer={formFooter}
        >
          {formFields}
        </BottomSheet>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent className="p-4 gap-3">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes <span className="font-medium text-foreground">{deleteTarget?.email}</span> from Auth and deletes their role row. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <Network className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-lg">Hierarchy assignments</CardTitle>
            <CardDescription>Assign manager and supervisor oversight for each non-admin user.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {hierarchyLoading || loading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ) : memberOptions.length === 0 ? (
          <p className="text-sm text-muted-foreground font-body">No non-admin users available for assignment.</p>
        ) : (
          <div className="space-y-3">
            {memberOptions.map((member) => {
              const row = hierarchy[member.id] || { manager_user_id: "", supervisor_user_id: "" };
              return (
                <div key={member.id} className="rounded-xl border border-border p-3 grid grid-cols-1 md:grid-cols-[1.3fr_1fr_1fr_auto] gap-3 items-end">
                  <div>
                    <p className="font-medium text-foreground">{member.full_name || member.email || "User"}</p>
                    <p className="text-xs text-muted-foreground">{member.email} • {member.role || "No role"}</p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Manager</Label>
                    <Select
                      value={row.manager_user_id || "__none__"}
                      onValueChange={(v) =>
                        setHierarchy((prev) => ({
                          ...prev,
                          [member.id]: {
                            ...(prev[member.id] || { manager_user_id: "", supervisor_user_id: "" }),
                            manager_user_id: v === "__none__" ? "" : v,
                          },
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select manager" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {managerOptions.map((m) => (
                          <SelectItem key={m.id} value={m.id}>{m.full_name || m.email || m.id}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Supervisor</Label>
                    <Select
                      value={row.supervisor_user_id || "__none__"}
                      onValueChange={(v) =>
                        setHierarchy((prev) => ({
                          ...prev,
                          [member.id]: {
                            ...(prev[member.id] || { manager_user_id: "", supervisor_user_id: "" }),
                            supervisor_user_id: v === "__none__" ? "" : v,
                          },
                        }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select supervisor" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {supervisorOptions.map((s) => (
                          <SelectItem key={s.id} value={s.id}>{s.full_name || s.email || s.id}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    onClick={() => void saveHierarchy(member.id)}
                    disabled={savingHierarchyFor === member.id}
                    className="w-full md:w-auto"
                  >
                    {savingHierarchyFor === member.id ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Save
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  );
}
