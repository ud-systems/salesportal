import { useLayoutEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import DashboardLayout from "@/components/DashboardLayout";
import DashboardRouter from "@/pages/DashboardRouter";
import CustomersPage from "@/pages/CustomersPage";
import OrdersPage from "@/pages/OrdersPage";
import ProductsPage from "@/pages/ProductsPage";
import InventoryPage from "@/pages/InventoryPage";
import CollectionsPage from "@/pages/CollectionsPage";
import PurchaseOrdersPage from "@/pages/PurchaseOrdersPage";
import SalespersonsPage from "@/pages/SalespersonsPage";
import SyncLogsPage from "@/pages/SyncLogsPage";
import WebhookMonitorPage from "@/pages/WebhookMonitorPage";
import SettingsPage from "@/pages/SettingsPage";
import LoginPage from "@/pages/LoginPage";
import ProfilePage from "@/pages/ProfilePage";
import AnalyticsPage from "@/pages/AnalyticsPage";
import ResetPasswordPage from "@/pages/ResetPasswordPage";
import NotFound from "./pages/NotFound.tsx";
import { PwaUpdateNotifier } from "@/components/PwaUpdateNotifier";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/** Sends password-recovery hash to `/reset-password`; otherwise `/login`. Site URL in Supabase often points at `/`. */
function RootEntry() {
  const navigate = useNavigate();
  useLayoutEffect(() => {
    const raw = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(raw);
    if (params.get("type") === "recovery" && params.get("access_token")) {
      navigate({ pathname: "/reset-password", hash: raw }, { replace: true });
      return;
    }
    navigate("/login", { replace: true });
  }, [navigate]);
  return (
    <div className="min-h-screen flex items-center justify-center gradient-bg">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

function ProtectedLayout() {
  return (
    <ProtectedRoute>
      <DashboardLayout />
    </ProtectedRoute>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <PwaUpdateNotifier />
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<RootEntry />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route element={<ProtectedLayout />}>
              <Route path="/dashboard" element={<DashboardRouter />} />
              <Route
                path="/analytics"
                element={
                  <ProtectedRoute requiredCapabilities={["view_salespersons_page"]}>
                    <AnalyticsPage />
                  </ProtectedRoute>
                }
              />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/collections" element={<ProtectedRoute requiredCapabilities={["view_procurement_pages"]}><CollectionsPage /></ProtectedRoute>} />
              <Route path="/purchase-orders" element={<ProtectedRoute requiredCapabilities={["view_procurement_pages"]}><PurchaseOrdersPage /></ProtectedRoute>} />
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/salespersons" element={<ProtectedRoute requiredCapabilities={["view_salespersons_page"]}><SalespersonsPage /></ProtectedRoute>} />
              <Route path="/sync-logs" element={<ProtectedRoute requiredCapabilities={["view_sync_logs"]}><SyncLogsPage /></ProtectedRoute>} />
              <Route path="/webhook-monitor" element={<ProtectedRoute requiredCapabilities={["view_webhook_monitor"]}><WebhookMonitorPage /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute requiredCapabilities={["manage_settings"]}><SettingsPage /></ProtectedRoute>} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
