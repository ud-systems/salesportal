import { LayoutDashboard, Users, ShoppingCart, Package, Menu, X, LogOut, UserCheck, RefreshCw, Boxes, Settings, FolderTree, ClipboardList, UserCircle, RadioTower, BarChart3 } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import type { AppCapability } from "@/lib/auth-capabilities";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const salespersonNav = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Analytics", url: "/analytics", icon: BarChart3 },
  { title: "Profile", url: "/profile", icon: UserCircle },
  { title: "Customers", url: "/customers", icon: Users },
  { title: "Orders", url: "/orders", icon: ShoppingCart },
  { title: "Products", url: "/products", icon: Package },
  { title: "Inventory", url: "/inventory", icon: Boxes },
];

const oversightNav: ({ title: string; url: string; icon: typeof LayoutDashboard; capability?: AppCapability })[] = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Analytics", url: "/analytics", icon: BarChart3 },
  { title: "Customers", url: "/customers", icon: Users },
  { title: "Orders", url: "/orders", icon: ShoppingCart },
  { title: "Products", url: "/products", icon: Package },
  { title: "Collections", url: "/collections", icon: FolderTree },
  { title: "Purchase Orders", url: "/purchase-orders", icon: ClipboardList },
  { title: "Inventory", url: "/inventory", icon: Boxes },
  { title: "Salespersons", url: "/salespersons", icon: UserCheck, capability: "view_salespersons_page" },
  { title: "Sync Logs", url: "/sync-logs", icon: RefreshCw, capability: "view_sync_logs" },
  { title: "Webhook Monitor", url: "/webhook-monitor", icon: RadioTower, capability: "view_webhook_monitor" },
  { title: "Settings", url: "/settings", icon: Settings, capability: "manage_settings" },
];

export function AppSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [navScrollProgress, setNavScrollProgress] = useState(0);
  const [hasNavOverflow, setHasNavOverflow] = useState(false);
  const { user, logout, hasCapability } = useAuth();
  const navigate = useNavigate();
  const navItems = hasCapability("view_org_dashboard")
    ? oversightNav.filter((item) => !item.capability || hasCapability(item.capability))
    : hasCapability("view_salespersons_page")
      ? [...salespersonNav, { title: "Salespersons", url: "/salespersons", icon: UserCheck }]
      : salespersonNav;
  const navRef = useRef<HTMLElement | null>(null);

  const updateNavScrollState = useCallback(() => {
    const navElement = navRef.current;
    if (!navElement) return;

    const maxScroll = navElement.scrollHeight - navElement.clientHeight;
    const isOverflowing = maxScroll > 0;
    setHasNavOverflow(isOverflowing);
    setNavScrollProgress(isOverflowing ? (navElement.scrollTop / maxScroll) * 100 : 0);
  }, []);

  useEffect(() => {
    updateNavScrollState();
  }, [updateNavScrollState, navItems.length]);

  useEffect(() => {
    window.addEventListener("resize", updateNavScrollState);
    return () => window.removeEventListener("resize", updateNavScrollState);
  }, [updateNavScrollState]);

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed top-4 left-4 z-50 lg:hidden tap-scale rounded-2xl bg-card p-2.5 border shadow-sm"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5 text-foreground" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-0 bg-foreground/20 backdrop-blur-sm" />
        </div>
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed top-0 left-0 z-50 h-screen w-64 bg-card border-r flex flex-col transition-transform duration-300 lg:sticky lg:top-0 lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-center justify-between p-5 pb-2">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl gradient-primary flex items-center justify-center">
              <img src="/white logo.png" alt="Logo" className="h-5 w-5 object-contain" />
            </div>
            <div>
              <h1 className="font-heading font-bold text-base text-foreground leading-tight">Sales Portal</h1>
              <p className="text-[11px] text-muted-foreground font-body">Sales Portal</p>
            </div>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden tap-scale p-1 rounded-lg hover:bg-muted"
            aria-label="Close menu"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="relative flex-1">
          {hasNavOverflow && (
            <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 h-1 bg-muted/70">
              <div
                className="h-full rounded-r-full bg-primary transition-[width] duration-150 ease-out"
                style={{ width: `${navScrollProgress}%` }}
              />
            </div>
          )}
          <nav
            ref={navRef}
            className="sidebar-scroll-hide h-full px-3 py-4 space-y-1 overflow-y-auto"
            onScroll={updateNavScrollState}
          >
            {navItems.map((item) => (
              <NavLink
                key={item.url}
                to={item.url}
                end
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-body font-medium text-muted-foreground hover:bg-muted transition-colors tap-scale"
                activeClassName="bg-primary text-primary-foreground hover:bg-primary"
                onClick={() => setMobileOpen(false)}
              >
                <item.icon className="h-[18px] w-[18px]" />
                <span>{item.title}</span>
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="p-3 border-t">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="h-8 w-8 rounded-full gradient-primary flex items-center justify-center">
              <span className="text-primary-foreground text-xs font-bold font-heading">{user?.initials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium font-body text-foreground truncate">{user?.name}</p>
              <p className="text-[11px] text-muted-foreground font-body capitalize">{user?.role}</p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                  <LogOut className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="rounded-xl">
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-heading text-base">Sign out now?</AlertDialogTitle>
                  <AlertDialogDescription className="font-body text-sm">
                    You will be logged out of this session and returned to the login page.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="rounded-xl font-body">Cancel</AlertDialogCancel>
                  <AlertDialogAction className="rounded-xl font-body" onClick={() => void handleLogout()}>
                    Sign out
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </aside>
    </>
  );
}
