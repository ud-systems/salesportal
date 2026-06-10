import { AppSidebar } from "@/components/AppSidebar";
import { OfflineBanner } from "@/components/OfflineBanner";
import { PostLoginNotifications } from "@/components/PostLoginNotifications";
import { NotificationBell } from "@/components/NotificationBell";
import { Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

function useSalespersonMobileHeroLayout() {
  const location = useLocation();
  const { isAdmin, isSupervisor, isManager, hasCapability } = useAuth();
  const onSalespersonDashboard = location.pathname.replace(/\/$/, "") === "/dashboard";
  const isSalespersonRole =
    !isAdmin && !isSupervisor && !isManager && !hasCapability("view_salespersons_page");
  return onSalespersonDashboard && isSalespersonRole;
}

export default function DashboardLayout() {
  const { isAdmin } = useAuth();
  const salespersonMobileHero = useSalespersonMobileHeroLayout();
  return (
    <div className="min-h-screen flex w-full gradient-bg">
      <PostLoginNotifications />
      <AppSidebar />
      <div className="fixed top-[max(1rem,env(safe-area-inset-top,0px))] right-4 z-50 lg:hidden">
        <NotificationBell />
      </div>
      <main
        data-salesperson-mobile-hero={salespersonMobileHero ? "" : undefined}
        className={cn(
          "flex-1 min-w-0 lg:p-6 lg:pt-6 lg:overflow-x-hidden",
          salespersonMobileHero ? "pb-4 lg:p-6" : "p-4 pt-16 overflow-x-hidden",
          !isAdmin && "flex flex-col items-stretch",
        )}
      >
        <div className={cn(salespersonMobileHero && "px-4 lg:px-0")}>
          <OfflineBanner />
        </div>
        <div className="w-full flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
