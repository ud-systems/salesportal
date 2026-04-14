import { AppSidebar } from "@/components/AppSidebar";
import { PostLoginNotifications } from "@/components/PostLoginNotifications";
import { Outlet } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

export default function DashboardLayout() {
  const { isAdmin } = useAuth();
  return (
    <div className="min-h-screen flex w-full gradient-bg">
      <PostLoginNotifications />
      <AppSidebar />
      <main
        className={cn(
          "flex-1 min-w-0 p-4 pt-16 lg:p-6 lg:pt-6 overflow-x-hidden",
          !isAdmin && "flex flex-col items-stretch",
        )}
      >
        <div className="w-full flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
