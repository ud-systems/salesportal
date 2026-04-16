import { useAuth } from "@/contexts/AuthContext";
import DashboardPage from "./DashboardPage";
import AdminDashboardPage from "./AdminDashboardPage";
import SupervisorDashboardPage from "./SupervisorDashboardPage";
import ManagerDashboardPage from "./ManagerDashboardPage";

export default function DashboardRouter() {
  const { isAdmin, isSupervisor, isManager, hasCapability } = useAuth();
  if (isAdmin) return <AdminDashboardPage />;
  if (isSupervisor) return <SupervisorDashboardPage />;
  if (isManager || hasCapability("view_salespersons_page")) return <ManagerDashboardPage />;
  return <DashboardPage />;
}
