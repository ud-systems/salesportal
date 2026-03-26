import { LayoutDashboard, Users, ShoppingCart, Package, Menu, X, LogOut, UserCheck, RefreshCw, Boxes, Settings, FolderTree, ClipboardList, UserCircle, RadioTower } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";

const salespersonNav = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Profile", url: "/profile", icon: UserCircle },
  { title: "Customers", url: "/customers", icon: Users },
  { title: "Orders", url: "/orders", icon: ShoppingCart },
  { title: "Products", url: "/products", icon: Package },
  { title: "Collections", url: "/collections", icon: FolderTree },
  { title: "Purchase Orders", url: "/purchase-orders", icon: ClipboardList },
  { title: "Inventory", url: "/inventory", icon: Boxes },
];

const adminNav = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Customers", url: "/customers", icon: Users },
  { title: "Orders", url: "/orders", icon: ShoppingCart },
  { title: "Products", url: "/products", icon: Package },
  { title: "Collections", url: "/collections", icon: FolderTree },
  { title: "Purchase Orders", url: "/purchase-orders", icon: ClipboardList },
  { title: "Inventory", url: "/inventory", icon: Boxes },
  { title: "Salespersons", url: "/salespersons", icon: UserCheck },
  { title: "Sync Logs", url: "/sync-logs", icon: RefreshCw },
  { title: "Webhook Monitor", url: "/webhook-monitor", icon: RadioTower },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const navItems = isAdmin ? adminNav : salespersonNav;

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
              <span className="text-primary-foreground font-heading font-bold text-sm">UD</span>
            </div>
            <div>
              <h1 className="font-heading font-bold text-base text-foreground leading-tight">UD Sales</h1>
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

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
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

        <div className="p-3 border-t">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="h-8 w-8 rounded-full gradient-primary flex items-center justify-center">
              <span className="text-primary-foreground text-xs font-bold font-heading">{user?.initials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium font-body text-foreground truncate">{user?.name}</p>
              <p className="text-[11px] text-muted-foreground font-body capitalize">{user?.role}</p>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={handleLogout}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
