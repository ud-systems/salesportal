import { DollarSign, ShoppingCart, Users, PackageX, CheckCircle2, AlertTriangle, Clock, X } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import {
  useCustomers,
  useCustomersCount,
  useOrdersCount,
  useOrdersTotalRevenue,
  useRecentOrders,
  useRevenueByMonthForYear,
  useUnfulfilledOrdersCount,
} from "@/hooks/use-shopify-data";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { useMemo, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";

const COLORS = ["hsl(100, 42%, 45%)", "hsl(100, 50%, 50%)", "hsl(40, 96%, 60%)", "hsl(210, 80%, 55%)", "hsl(0, 70%, 55%)"];
const DASHBOARD_UNASSIGNED = "Unassigned";
/** Matches Customers / sync: null or literal Unassigned */
function customerIsUnassigned(c: { sp_assigned?: string | null }): boolean {
  return !c.sp_assigned || c.sp_assigned === DASHBOARD_UNASSIGNED;
}
const UNASSIGNED_PIE_COLOR = "hsl(38, 92%, 50%)";

export default function AdminDashboardPage() {
  const LICENSE_BANNER_DISMISS_UNTIL_KEY = "datapulse_license_banner_dismiss_until_ms";
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const year = new Date().getUTCFullYear();
  const { data: customers, isLoading: loadingCustomers } = useCustomers();
  const { data: totalOrders = 0, isLoading: loadingOrdersCount } = useOrdersCount();
  const { data: totalCustomers = 0, isLoading: loadingCustomersCount } = useCustomersCount();
  const { data: totalRevenue = 0, isLoading: loadingRevenueTotal } = useOrdersTotalRevenue();
  const { data: unfulfilledOrders = 0, isLoading: loadingUnfulfilled } = useUnfulfilledOrdersCount();
  const { data: recentOrders = [], isLoading: loadingRecentOrders } = useRecentOrders(10);
  const { data: revenueData = [], isLoading: loadingRevenue } = useRevenueByMonthForYear(year);
  const [licenseCode, setLicenseCode] = useState("");
  const [licenseExpiresAt, setLicenseExpiresAt] = useState("");
  const [licenseMode, setLicenseMode] = useState<"renewable" | "lifetime">("renewable");
  const [nowMs, setNowMs] = useState(Date.now());
  const [dismissedUntilMs, setDismissedUntilMs] = useState(0);

  useEffect(() => {
    const loadLicenseSettings = async () => {
      const { data } = await (supabase as any)
        .from("app_settings")
        .select("key, value")
        .in("key", ["datapulse_access_code", "datapulse_access_expires_at", "datapulse_license_mode"]);
      const rows = data || [];
      setLicenseCode((rows.find((r: any) => r.key === "datapulse_access_code")?.value || "").trim());
      setLicenseExpiresAt((rows.find((r: any) => r.key === "datapulse_access_expires_at")?.value || "").trim());
      setLicenseMode(
        (rows.find((r: any) => r.key === "datapulse_license_mode")?.value || "renewable").trim() === "lifetime"
          ? "lifetime"
          : "renewable",
      );
    };
    void loadLicenseSettings();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem(LICENSE_BANNER_DISMISS_UNTIL_KEY);
    const parsed = Number(raw || "0");
    setDismissedUntilMs(Number.isFinite(parsed) ? parsed : 0);
  }, []);

  const salesBySP = useMemo(() => {
    const map: Record<string, number> = {};
    let unassignedRevenue = 0;
    for (const c of customers || []) {
      if (customerIsUnassigned(c)) {
        unassignedRevenue += Number(c.total_revenue || 0);
        continue;
      }
      const key = c.sp_assigned as string;
      map[key] = (map[key] || 0) + Number(c.total_revenue || 0);
    }
    const assignedRows = Object.entries(map)
      .map(([name, revenue]) => ({ name: name.split(" ")[0], fullName: name, revenue }))
      .sort((a, b) => b.revenue - a.revenue);
    const unassignedCount = (customers || []).filter(customerIsUnassigned).length;
    if (unassignedCount > 0 || unassignedRevenue > 0) {
      return [
        ...assignedRows,
        { name: DASHBOARD_UNASSIGNED, fullName: DASHBOARD_UNASSIGNED, revenue: unassignedRevenue },
      ];
    }
    return assignedRows;
  }, [customers]);

  const expiryMs = licenseExpiresAt ? new Date(licenseExpiresAt).getTime() : 0;
  const hasLicense = Boolean(licenseCode);
  const isLifetime = licenseMode === "lifetime";
  const licenseActive = hasLicense && (isLifetime || expiryMs > nowMs);
  const licenseExpired = hasLicense && !isLifetime && expiryMs > 0 && expiryMs <= nowMs;
  const remainingMs = Math.max(0, expiryMs - nowMs);
  const showWarningWindow = licenseActive && !isLifetime && remainingMs <= SEVEN_DAYS_MS;
  const isTemporarilyDismissed = dismissedUntilMs > nowMs;
  const showLicenseBanner = licenseExpired || (showWarningWindow && !isTemporarilyDismissed);
  const days = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const mins = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
  const secs = Math.floor((remainingMs % (1000 * 60)) / 1000);
  const countdown = `${days}d ${String(hours).padStart(2, "0")}h ${String(mins).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
  const handleDismissBanner = () => {
    if (licenseExpired) return;
    const next = Date.now() + ONE_HOUR_MS;
    setDismissedUntilMs(next);
    localStorage.setItem(LICENSE_BANNER_DISMISS_UNTIL_KEY, String(next));
  };

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Admin Dashboard</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">Organization-wide overview</p>
      </div>

      {showLicenseBanner && (
        <div
          className={`rounded-xl border p-4 opacity-0 animate-fade-in ${
            licenseExpired ? "border-destructive/40 bg-destructive/10" : "border-amber-500/30 bg-amber-500/10"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              {licenseExpired ? (
                <AlertTriangle className="h-5 w-5 text-destructive mt-0.5" />
              ) : (
                <Clock className="h-5 w-5 text-amber-600 mt-0.5" />
              )}
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {licenseExpired ? "License Expired - Sync Locked" : "License Expires Soon"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {licenseExpired
                    ? "Renew in DataPulseFlow guest checkout, then enter the new code in Settings to unlock sync."
                    : "Your license has 7 days or less remaining. Renew in time to avoid sync interruption."}
                </p>
                <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                  <p className="text-xs text-muted-foreground font-mono">{licenseCode || "No code saved"}</p>
                  <p className={`text-xs font-medium flex items-center gap-1 ${licenseExpired ? "text-destructive" : "text-amber-700 dark:text-amber-400"}`}>
                    <Clock className="h-3.5 w-3.5" />
                    {licenseExpired ? "Expired" : countdown}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {licenseExpiresAt ? `Expires: ${new Date(licenseExpiresAt).toLocaleString()}` : "No expiry saved"}
                  </p>
                </div>
              </div>
            </div>
            {!licenseExpired && (
              <button
                type="button"
                onClick={handleDismissBanner}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/70 text-muted-foreground hover:text-foreground transition-colors"
                title="Dismiss for 1 hour"
                aria-label="Dismiss for 1 hour"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {isLifetime && hasLicense && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 opacity-0 animate-fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
            <div>
              <p className="text-sm font-semibold text-foreground">Enterprise Lifetime License Active</p>
              <p className="text-xs text-muted-foreground font-mono">{licenseCode}</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
        <KpiCard
          title="Total Revenue"
          value={loadingRevenueTotal ? <Skeleton className="h-8 w-24 rounded-md" /> : `$${totalRevenue.toLocaleString()}`}
          icon={DollarSign}
          delay={50}
        />
        <KpiCard
          title="Total Orders"
          value={loadingOrdersCount ? <Skeleton className="h-8 w-16 rounded-md" /> : totalOrders.toString()}
          icon={ShoppingCart}
          delay={100}
        />
        <KpiCard
          title="Total Customers"
          value={loadingCustomersCount ? <Skeleton className="h-8 w-16 rounded-md" /> : totalCustomers.toString()}
          icon={Users}
          delay={150}
        />
        <Link to="/orders?fulfillment=unfulfilled" className="block">
          <KpiCard
            title="Unfulfilled Orders"
            value={loadingUnfulfilled ? <Skeleton className="h-8 w-16 rounded-md" /> : unfulfilledOrders.toString()}
            icon={PackageX}
            delay={200}
          />
        </Link>
      </div>

      <div className={`grid grid-cols-1 gap-4 ${salesBySP.length > 0 ? "lg:grid-cols-2" : ""}`}>
        <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
          <h3 className="font-heading font-semibold text-foreground mb-4">Revenue by Month ({revenueData[0]?.year || year})</h3>
          {loadingRevenue ? (
            <Skeleton className="h-[220px] w-full rounded-xl" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={revenueData} margin={{ top: 6, right: 0, left: 0, bottom: 0 }} barCategoryGap="22%">
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" padding={{ left: 0, right: 0 }} tick={{ fontSize: 12, fontFamily: 'Inter Tight' }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                <YAxis width={40} tick={{ fontSize: 12, fontFamily: 'Inter Tight' }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', fontFamily: 'Inter Tight', fontSize: 13 }} formatter={(value: number) => [`$${value.toLocaleString()}`, "Revenue"]} />
                <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        {!loadingCustomers && salesBySP.length > 0 && (
          <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
            <h3 className="font-heading font-semibold text-foreground mb-4">Sales by Salesperson</h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={salesBySP} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="revenue" nameKey="name">
                  {salesBySP.map((sp, index) => {
                    const assignedBefore = salesBySP.slice(0, index).filter((s) => s.fullName !== DASHBOARD_UNASSIGNED).length;
                    const fill =
                      sp.fullName === DASHBOARD_UNASSIGNED ? UNASSIGNED_PIE_COLOR : COLORS[assignedBefore % COLORS.length];
                    return <Cell key={sp.fullName} fill={fill} />;
                  })}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid hsl(var(--border))", fontFamily: "Inter Tight", fontSize: 13 }} formatter={(value: number) => `$${value.toLocaleString()}`} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap justify-center gap-3 mt-2">
              {salesBySP.map((sp, index) => {
                const assignedBefore = salesBySP.slice(0, index).filter((s) => s.fullName !== DASHBOARD_UNASSIGNED).length;
                const dotColor =
                  sp.fullName === DASHBOARD_UNASSIGNED ? UNASSIGNED_PIE_COLOR : COLORS[assignedBefore % COLORS.length];
                return (
                  <div key={sp.fullName} className="flex items-center gap-1.5 text-xs font-body text-muted-foreground">
                    <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: dotColor }} />
                    {sp.name}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {!loadingCustomers && salesBySP.length > 0 && (
        <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "400ms" }}>
          <h3 className="font-heading font-semibold text-foreground mb-4">Salesperson Performance</h3>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm font-body">
              <thead><tr className="border-b text-muted-foreground"><th className="text-left py-2.5 font-medium">Name</th><th className="text-right py-2.5 font-medium">Customers</th><th className="text-right py-2.5 font-medium">Revenue</th></tr></thead>
              <tbody>
                {salesBySP.map((sp) => {
                  const custCount =
                    sp.fullName === DASHBOARD_UNASSIGNED
                      ? (customers || []).filter(customerIsUnassigned).length
                      : (customers || []).filter((c) => c.sp_assigned === sp.fullName).length;
                  const isUnassignedRow = sp.fullName === DASHBOARD_UNASSIGNED;
                  return (
                    <tr key={sp.fullName} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                      <td className="py-3">
                        <div className="flex items-center gap-3">
                          <div
                            className={`h-8 w-8 rounded-full flex items-center justify-center ${
                              isUnassignedRow ? "bg-warning/20" : "gradient-primary"
                            }`}
                          >
                            <span
                              className={`text-[10px] font-bold font-heading ${
                                isUnassignedRow ? "text-warning" : "text-primary-foreground"
                              }`}
                            >
                              {sp.fullName.split(" ").map((w) => w[0]).join("")}
                            </span>
                          </div>
                          <p className="font-medium text-foreground">{sp.fullName}</p>
                        </div>
                      </td>
                      <td className="py-3 text-right font-medium text-foreground">{custCount}</td>
                      <td className="py-3 text-right font-medium text-foreground">${sp.revenue.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="md:hidden space-y-3">
            {salesBySP.map((sp) => {
              const custCount =
                sp.fullName === DASHBOARD_UNASSIGNED
                  ? (customers || []).filter(customerIsUnassigned).length
                  : (customers || []).filter((c) => c.sp_assigned === sp.fullName).length;
              return (
                <div key={sp.fullName} className="p-3 rounded-xl bg-muted/50 tap-scale">
                  <p className="font-medium text-foreground text-sm">{sp.fullName}</p>
                  <div className="flex justify-between text-xs font-body text-muted-foreground mt-1">
                    <span>{custCount} customers</span>
                    <span className="font-medium text-foreground">${sp.revenue.toLocaleString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "350ms" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-heading font-semibold text-foreground">Recent Orders</h3>
          <Button asChild variant="outline" className="rounded-xl h-9 font-body">
            <Link to="/orders">View All</Link>
          </Button>
        </div>
        {loadingRecentOrders ? (
          <div className="space-y-3 py-1">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ) : recentOrders.length === 0 ? (
          <p className="text-muted-foreground font-body text-sm text-center py-6">No orders yet. Run a Shopify sync to pull data.</p>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm font-body">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2.5 font-medium">Order</th>
                    <th className="text-left py-2.5 font-medium">Customer</th>
                    <th className="text-right py-2.5 font-medium">Amount</th>
                    <th className="text-left py-2.5 font-medium">Status</th>
                    <th className="text-left py-2.5 font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOrders.map((order) => (
                    <tr key={order.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                      <td className="py-3 font-medium text-foreground">{order.order_number || order.shopify_order_id}</td>
                      <td className="py-3 text-muted-foreground">{order.customer_name}</td>
                      <td className="py-3 text-right font-medium text-foreground">${Number(order.total || 0).toLocaleString()}</td>
                      <td className="py-3"><StatusBadge status={(order.financial_status || "pending") as any} /></td>
                      <td className="py-3 text-muted-foreground">{order.shopify_created_at ? new Date(order.shopify_created_at).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="md:hidden space-y-3">
              {recentOrders.map((order) => (
                <div key={order.id} className="flex items-center justify-between p-3 rounded-xl bg-muted/50 tap-scale">
                  <div>
                    <p className="font-medium text-foreground text-sm">{order.order_number || order.shopify_order_id}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{order.customer_name}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium text-foreground text-sm">${Number(order.total || 0).toLocaleString()}</p>
                    <StatusBadge status={(order.financial_status || "pending") as any} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

    </div>
  );
}
