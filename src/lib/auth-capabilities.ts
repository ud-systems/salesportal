import type { UserRole } from "@/contexts/AuthContext";

export type AppCapability =
  | "view_org_dashboard"
  | "view_salespersons_page"
  | "view_procurement_pages"
  | "view_sync_logs"
  | "view_webhook_monitor"
  | "manage_settings"
  | "manage_users";

const roleCapabilities: Record<UserRole, AppCapability[]> = {
  admin: [
    "view_org_dashboard",
    "view_salespersons_page",
    "view_procurement_pages",
    "view_sync_logs",
    "view_webhook_monitor",
    "manage_settings",
    "manage_users",
  ],
  owner: [
    "view_org_dashboard",
    "view_salespersons_page",
    "view_procurement_pages",
    "view_sync_logs",
    "manage_users",
  ],
  supervisor: [
    "view_org_dashboard",
    "view_salespersons_page",
  ],
  manager: [
    "view_salespersons_page",
  ],
  salesperson: [],
};

export function resolveCapabilities(roles: UserRole[]): AppCapability[] {
  const set = new Set<AppCapability>();
  for (const role of roles) {
    for (const capability of roleCapabilities[role] ?? []) {
      set.add(capability);
    }
  }
  return [...set];
}
