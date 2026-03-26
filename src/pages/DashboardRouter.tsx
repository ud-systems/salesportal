import { useAuth } from "@/contexts/AuthContext";
import DashboardPage from "./DashboardPage";
import AdminDashboardPage from "./AdminDashboardPage";

export default function DashboardRouter() {
  const { isAdmin } = useAuth();
  return isAdmin ? <AdminDashboardPage /> : <DashboardPage />;
}
