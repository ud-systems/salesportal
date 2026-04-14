import { DollarSign, ShoppingCart, Users, PackageX, CheckCircle2, AlertTriangle, Clock, X, Search } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import {
  useCustomers,
  useCustomersCount,
  useCustomersCountInRange,
  useOrdersCount,
  useOrdersMetricsInRange,
  useOrdersTotalRevenue,
  useRecentOrders,
  useRecentOrdersInRange,
  useRevenueByMonthForYear,
  useOrdersTimeseriesInRange,
  useUnfulfilledOrdersCount,
} from "@/hooks/use-shopify-data";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { useMemo, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getDashboardRange, toRangeIso, type DatePreset } from "@/lib/dashboard-date-range";
import { differenceInCalendarDays } from "date-fns";
import { formatOrderMoney, formatDisplayDate, formatCompactMoney } from "@/lib/format";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";

const DASHBOARD_UNASSIGNED = "Unassigned";
const TOP_SALES_BAR_COLORS = [
  "hsl(100 45% 42%)",
  "hsl(104 46% 46%)",
  "hsl(110 44% 40%)",
  "hsl(96 42% 48%)",
  "hsl(114 38% 44%)",
  "hsl(92 40% 50%)",
  "hsl(120 36% 38%)",
  "hsl(88 38% 46%)",
];
/** Matches Customers / sync: null or literal Unassigned */
function customerIsUnassigned(c: { sp_assigned?: string | null }): boolean {
  return !c.sp_assigned || c.sp_assigned === DASHBOARD_UNASSIGNED;
}

export default function AdminDashboardPage() {
  const LICENSE_BANNER_DISMISS_UNTIL_KEY = "datapulse_license_banner_dismiss_until_ms";
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const year = new Date().getUTCFullYear();
  const { data: currency = "GBP" } = useShopDisplayCurrency();
  const [preset, setPreset] = useState<DatePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const range = useMemo(
    () => getDashboardRange(preset, customFrom || undefined, customTo || undefined),
    [preset, customFrom, customTo],
  );
  const fromIso = toRangeIso(range.from);
  const toIso = toRangeIso(range.to);
  const cmpFromIso = toRangeIso(range.compareFrom);
  const cmpToIso = toRangeIso(range.compareTo);
  const isAll = preset === "all";
  const rangeDays =
    range.from && range.to ? Math.max(1, differenceInCalendarDays(range.to, range.from) + 1) : 365;
  const bucket = rangeDays <= 62 ? "day" : "month";

  const { data: customers, isLoading: loadingCustomers } = useCustomers();
  const { data: totalOrdersAll = 0, isLoading: loadingOrdersAll } = useOrdersCount();
  const { data: totalCustomersAll = 0, isLoading: loadingCustomersAll } = useCustomersCount();
  const { data: totalRevenueAll = 0, isLoading: loadingRevenueAll } = useOrdersTotalRevenue();
  const { data: metricsRange, isLoading: loadingMetricsRange } = useOrdersMetricsInRange(fromIso, toIso, "admin", !isAll);
  const { data: metricsCompare } = useOrdersMetricsInRange(cmpFromIso, cmpToIso, "admin", !isAll && Boolean(cmpFromIso && cmpToIso));
  const { data: customersRange = 0, isLoading: loadingCustomersRange } = useCustomersCountInRange(
    fromIso,
    toIso,
    "admin",
    !isAll,
  );
  const { data: seriesRange = [], isLoading: loadingSeries } = useOrdersTimeseriesInRange(
    fromIso,
    toIso,
    bucket,
    "admin",
    !isAll,
  );
  const { data: unfulfilledOrders = 0, isLoading: loadingUnfulfilled } = useUnfulfilledOrdersCount();
  const { data: recentOrdersAll = [], isLoading: loadingRecentAll } = useRecentOrders(10);
  const { data: recentFiltered = [], isLoading: loadingRecentFiltered } = useRecentOrdersInRange(
    10,
    fromIso,
    toIso,
    "admin",
    !isAll,
  );
  const { data: revenueData = [], isLoading: loadingRevenue } = useRevenueByMonthForYear(year);
  const totalRevenue = isAll ? totalRevenueAll : (metricsRange?.revenue ?? 0);
  const totalOrders = isAll ? totalOrdersAll : (metricsRange?.count ?? 0);
  const totalCustomers = isAll ? totalCustomersAll : customersRange;
  const recentOrders = isAll ? recentOrdersAll : recentFiltered;
  const loadingRevenueTotal = isAll ? loadingRevenueAll : loadingMetricsRange;
  const loadingOrdersCount = isAll ? loadingOrdersAll : loadingMetricsRange;
  const loadingCustomersCount = isAll ? loadingCustomersAll : loadingCustomersRange;
  const loadingRecentOrders = isAll ? loadingRecentAll : loadingRecentFiltered;
  const prevRevenue = metricsCompare?.revenue ?? 0;
  const revDelta =
    !isAll && prevRevenue > 0 ? (((totalRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1) : null;
  const barChartData = useMemo(() => {
    if (isAll) return revenueData;
    return seriesRange.map((p) => ({ month: p.label, revenue: p.revenue, orders: p.orders, year }));
  }, [isAll, revenueData, seriesRange, year]);
  const loadingBar = isAll ? loadingRevenue : loadingSeries;

  const [licenseCode, setLicenseCode] = useState("");
  const [licenseExpiresAt, setLicenseExpiresAt] = useState("");
  const [licenseMode, setLicenseMode] = useState<"renewable" | "lifetime">("renewable");
  const [nowMs, setNowMs] = useState(Date.now());
  const [dismissedUntilMs, setDismissedUntilMs] = useState(0);
  const [salespersonSearch, setSalespersonSearch] = useState("");
  const [salespersonPage, setSalespersonPage] = useState(1);

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
  const salesRows = useMemo(
    () =>
      salesBySP.map((sp) => ({
        ...sp,
        custCount:
          sp.fullName === DASHBOARD_UNASSIGNED
            ? (customers || []).filter(customerIsUnassigned).length
            : (customers || []).filter((c) => c.sp_assigned === sp.fullName).length,
      })),
    [salesBySP, customers],
  );
  const filteredSalesRows = useMemo(() => {
    const q = salespersonSearch.trim().toLowerCase();
    if (!q) return salesRows;
    return salesRows.filter((row) => row.fullName.toLowerCase().includes(q) || row.name.toLowerCase().includes(q));
  }, [salesRows, salespersonSearch]);
  const SALES_ROWS_PER_PAGE = 8;
  const topSalesRows = useMemo(() => salesRows.slice(0, 8), [salesRows]);
  const topSalesMaxRevenue = useMemo(
    () => Math.max(1, ...topSalesRows.map((row) => Number(row.revenue || 0))),
    [topSalesRows],
  );
  const salespersonTotalPages = Math.max(1, Math.ceil(filteredSalesRows.length / SALES_ROWS_PER_PAGE));
  const pagedSalesRows = useMemo(() => {
    const start = (salespersonPage - 1) * SALES_ROWS_PER_PAGE;
    return filteredSalesRows.slice(start, start + SALES_ROWS_PER_PAGE);
  }, [filteredSalesRows, salespersonPage]);

  useEffect(() => {
    setSalespersonPage(1);
  }, [salespersonSearch]);

  useEffect(() => {
    if (salespersonPage > salespersonTotalPages) setSalespersonPage(salespersonTotalPages);
  }, [salespersonPage, salespersonTotalPages]);

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

      <div className="card-float p-4 opacity-0 animate-fade-in flex flex-col sm:flex-row flex-wrap gap-3 items-stretch sm:items-end">
        <div className="flex-1 min-w-[160px]">
          <p className="text-xs font-medium text-muted-foreground font-body mb-1.5">Period</p>
          <Select value={preset} onValueChange={(v) => setPreset(v as DatePreset)}>
            <SelectTrigger className="rounded-xl h-10 font-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All time</SelectItem>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="week">Last 7 days</SelectItem>
              <SelectItem value="month">This month</SelectItem>
              <SelectItem value="quarter">This quarter</SelectItem>
              <SelectItem value="year">This year</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {preset === "custom" && (
          <div className="flex flex-col sm:flex-row gap-2 flex-1">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-10 rounded-xl border bg-card px-3 text-sm font-body flex-1"
            />
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-10 rounded-xl border bg-card px-3 text-sm font-body flex-1"
            />
          </div>
        )}
        {!isAll && (
          <p className="text-xs text-muted-foreground font-body sm:ml-auto sm:text-right w-full sm:w-auto">
            vs previous equivalent period
            {revDelta != null ? ` · Revenue ${Number(revDelta) >= 0 ? "+" : ""}${revDelta}%` : ""}
          </p>
        )}
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
          value={
            loadingRevenueTotal ? (
              <Skeleton className="h-8 w-24 rounded-md" />
            ) : (
              formatOrderMoney(totalRevenue, null, currency)
            )
          }
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

      <div className={`grid grid-cols-1 items-stretch gap-4 ${salesBySP.length > 0 ? "lg:grid-cols-2" : ""}`}>
        <div className="card-float p-5 h-full flex flex-col opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
          <h3 className="font-heading font-semibold text-foreground mb-4">
            {isAll ? `Revenue by Month (${revenueData[0]?.year || year})` : "Revenue (selected period)"}
          </h3>
          {loadingBar ? (
            <Skeleton className="h-[220px] w-full rounded-xl" />
          ) : (
            <div className="flex-1 min-h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={barChartData}
                  margin={{ top: 6, right: 0, left: 0, bottom: 0 }}
                  barCategoryGap="8%"
                  barGap={0}
                  maxBarSize={40}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" padding={{ left: 0, right: 0 }} tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                  <YAxis width={48} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => formatCompactMoney(v, currency)} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid hsl(var(--border))", fontSize: 13 }} formatter={(value: number) => [formatOrderMoney(value, null, currency), "Revenue"]} />
                  <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        {!loadingCustomers && salesBySP.length > 0 && (
          <div className="card-float p-5 h-full opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
            <h3 className="font-heading font-semibold text-foreground mb-4">Top 8 Salesperson Revenue Progress</h3>
            <div className="space-y-3">
              {topSalesRows.map((sp, idx) => {
                const widthPct = Math.max(4, Math.round((Number(sp.revenue || 0) / topSalesMaxRevenue) * 100));
                const barColor = TOP_SALES_BAR_COLORS[idx % TOP_SALES_BAR_COLORS.length];
                return (
                  <div key={sp.fullName} className="flex items-center gap-3">
                    <div className="flex-1">
                      <div className="h-8 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full transition-[width] duration-300"
                          style={{ width: `${widthPct}%`, backgroundColor: barColor }}
                        />
                      </div>
                    </div>
                    <div className="w-[150px] text-right">
                      <p className="text-xs font-medium text-foreground truncate">{sp.name}</p>
                      <p className="text-[11px] text-muted-foreground font-body">
                        {formatOrderMoney(sp.revenue, null, currency)}
                      </p>
                    </div>
                  </div>
                );
              })}
              {topSalesRows.length === 0 && (
                <p className="text-sm text-muted-foreground font-body text-center py-6">No salesperson revenue yet.</p>
              )}
            </div>
          </div>
        )}
      </div>
      {!loadingCustomers && salesBySP.length > 0 && (
        <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "400ms" }}>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="font-heading font-semibold text-foreground">Salesperson Performance</h3>
            <div className="relative w-full sm:w-[280px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={salespersonSearch}
                onChange={(e) => setSalespersonSearch(e.target.value)}
                placeholder="Search salesperson"
                className="h-9 w-full rounded-xl border bg-card pl-9 pr-3 text-sm font-body"
              />
            </div>
          </div>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm font-body">
              <thead><tr className="border-b text-muted-foreground"><th className="text-left py-2.5 font-medium">Name</th><th className="text-right py-2.5 font-medium">Customers</th><th className="text-right py-2.5 font-medium">Revenue</th></tr></thead>
              <tbody>
                {pagedSalesRows.map((sp) => {
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
                      <td className="py-3 text-right font-medium text-foreground">{sp.custCount}</td>
                      <td className="py-3 text-right font-medium text-foreground">{formatOrderMoney(sp.revenue, null, currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="md:hidden space-y-3">
            {pagedSalesRows.map((sp) => {
              return (
                <div key={sp.fullName} className="p-3 rounded-xl bg-muted/50 tap-scale">
                  <p className="font-medium text-foreground text-sm">{sp.fullName}</p>
                  <div className="flex justify-between text-xs font-body text-muted-foreground mt-1">
                    <span>{sp.custCount} customers</span>
                    <span className="font-medium text-foreground">{formatOrderMoney(sp.revenue, null, currency)}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {filteredSalesRows.length === 0 ? (
            <p className="text-sm text-muted-foreground font-body text-center py-6">No salespersons match your search.</p>
          ) : (
            <div className="mt-4 flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground font-body">
                Showing {(salespersonPage - 1) * SALES_ROWS_PER_PAGE + 1}-
                {Math.min(salespersonPage * SALES_ROWS_PER_PAGE, filteredSalesRows.length)} of {filteredSalesRows.length}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  className="h-8 rounded-lg px-3 text-xs"
                  disabled={salespersonPage <= 1}
                  onClick={() => setSalespersonPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </Button>
                <p className="text-xs text-muted-foreground font-body">
                  Page {salespersonPage} of {salespersonTotalPages}
                </p>
                <Button
                  variant="outline"
                  className="h-8 rounded-lg px-3 text-xs"
                  disabled={salespersonPage >= salespersonTotalPages}
                  onClick={() => setSalespersonPage((p) => Math.min(salespersonTotalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
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
                      <td className="py-3 text-right font-medium text-foreground">
                        {formatOrderMoney(Number(order.total || 0), (order as { currency_code?: string | null }).currency_code, currency)}
                      </td>
                      <td className="py-3"><StatusBadge status={(order.financial_status || "pending") as any} /></td>
                      <td className="py-3 text-muted-foreground">{formatDisplayDate(order.shopify_created_at)}</td>
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
                    <p className="font-medium text-foreground text-sm">
                      {formatOrderMoney(Number(order.total || 0), (order as { currency_code?: string | null }).currency_code, currency)}
                    </p>
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
