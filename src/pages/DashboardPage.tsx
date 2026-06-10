import { AlertCircle, ShoppingCart, Users } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import {
  useRecentOrdersInRange,
  useScopeOrderTimeseries,
  useShopifyAnalyticsDashboard,
  shopifyAnalyticsToSalesBreakdown,
  emptyShopifyAnalyticsDashboard,
  useTopCustomers,
} from "@/hooks/use-shopify-data";
import { useAuth } from "@/contexts/AuthContext";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DashboardOverviewSummaryCard } from "@/components/DashboardOverviewSummaryCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getDashboardRange, toRangeIso, formatPresetLabel, type DatePreset } from "@/lib/dashboard-date-range";
import { PeriodSelectItems } from "@/components/PeriodSelectItems";
import { differenceInCalendarDays } from "date-fns";
import { formatOrderMoney, formatDisplayDate, formatCompactMoney } from "@/lib/format";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";

export default function DashboardPage() {
  const { user } = useAuth();
  const scopeKey = user?.id ?? "anonymous";
  const { data: currency = "GBP" } = useShopDisplayCurrency();

  const [preset, setPreset] = useState<DatePreset>(() =>
    typeof window !== "undefined" && window.innerWidth < 1024 ? "today" : "all",
  );
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const range = useMemo(
    () => getDashboardRange(preset, customFrom || undefined, customTo || undefined),
    [preset, customFrom, customTo],
  );
  const fromIso = toRangeIso(range.from);
  const toIso = toRangeIso(range.to);
  const rangeDays =
    range.from && range.to ? Math.max(1, differenceInCalendarDays(range.to, range.from) + 1) : 365;
  const bucket = rangeDays <= 62 ? "day" : "month";
  const trendLabel = useMemo(() => formatPresetLabel(preset), [preset]);

  const { data: analytics, isLoading: loadingAnalytics } = useShopifyAnalyticsDashboard(
    user?.id,
    fromIso,
    toIso,
    Boolean(user?.id),
  );
  const { data: chartSeries = [], isLoading: loadingSeries } = useScopeOrderTimeseries(
    user?.id,
    fromIso,
    toIso,
    bucket,
    scopeKey,
    Boolean(user?.id),
  );
  const { data: recentOrders = [], isLoading: loadingRecentOrders } = useRecentOrdersInRange(
    5,
    fromIso,
    toIso,
    scopeKey,
    Boolean(user?.id),
  );

  const { data: topCustomers = [], isLoading: loadingTopCustomers } = useTopCustomers(3, scopeKey);
  const totalSales = analytics?.total_sales ?? 0;
  const totalOrders = analytics?.orders_total ?? 0;
  const paidOrders = analytics?.orders_paid ?? 0;
  const pendingOrders = analytics?.orders_pending ?? 0;
  const refundedOrders = analytics?.orders_refunded ?? 0;
  const totalCustomers = analytics?.customers_count ?? 0;
  const unfulfilledOrders = analytics?.orders_unfulfilled ?? 0;

  const shopifySalesBreakdown = useMemo(
    () => shopifyAnalyticsToSalesBreakdown(analytics ?? emptyShopifyAnalyticsDashboard()),
    [analytics],
  );
  const netSales = shopifySalesBreakdown?.net_sales_derived ?? 0;

  const chartData = useMemo(
    () => chartSeries.map((p) => ({ label: p.label, revenue: p.revenue, orders: p.orders })),
    [chartSeries],
  );
  const hasChartData = useMemo(
    () => chartData.some((point) => Number(point.revenue || 0) > 0 || Number(point.orders || 0) > 0),
    [chartData],
  );

  const loadingChart = loadingSeries;

  const firstName = user?.name?.split(" ")[0] || "there";
  const displayName = user?.name?.trim() || firstName;

  return (
    <>
      <div className="fixed top-[max(1rem,env(safe-area-inset-top,0px))] right-[4.25rem] z-50 lg:hidden w-auto max-w-[calc(100vw-8.5rem)]">
        <Select value={preset} onValueChange={(v) => setPreset(v as DatePreset)}>
          <SelectTrigger className="rounded-xl h-10 w-auto min-w-[6.75rem] max-w-[9.5rem] font-body bg-card/95 backdrop-blur-sm border shadow-sm px-3">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <PeriodSelectItems />
          </SelectContent>
        </Select>
      </div>

      <div className="lg:hidden salesperson-mobile-hero-shell mb-1 text-center">
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="h-11 w-11 rounded-full bg-primary-foreground/15 ring-1 ring-primary-foreground/25 flex items-center justify-center shrink-0">
            <span className="text-primary-foreground text-sm font-heading font-bold">{user?.initials}</span>
          </div>
          <p className="text-lg font-heading font-bold leading-tight">{displayName}</p>
        </div>

        <p className="text-sm font-body font-medium text-primary-foreground/90">Net sales</p>
        {loadingAnalytics ? (
          <Skeleton className="h-12 w-52 max-w-full mx-auto mt-2 rounded-xl bg-primary-foreground/20" />
        ) : (
          <p className="text-[2.5rem] leading-tight font-heading font-bold tabular-nums mt-1 tracking-tight">
            {formatOrderMoney(netSales, null, currency)}
          </p>
        )}
        <p className="text-xs font-body text-primary-foreground/75 mt-1.5">{trendLabel}</p>

        <div className="flex flex-wrap items-center justify-center gap-3 mt-8">
          <Button
            asChild
            variant="ghost"
            className="h-10 w-auto rounded-full px-4 bg-card text-foreground font-heading font-semibold text-sm shadow-sm border-0 transition-all duration-200 hover:bg-white hover:text-foreground hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.97] tap-scale"
          >
            <Link to="/customers">
              <Users className="h-4 w-4 shrink-0" aria-hidden />
              Customers
            </Link>
          </Button>
          <Button
            asChild
            variant="ghost"
            className="h-10 w-auto rounded-full px-4 bg-card text-foreground font-heading font-semibold text-sm shadow-sm border-0 transition-all duration-200 hover:bg-white hover:text-foreground hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.97] tap-scale"
          >
            <Link to="/orders">
              <ShoppingCart className="h-4 w-4 shrink-0" aria-hidden />
              Orders
            </Link>
          </Button>
        </div>
      </div>

    <div className="space-y-6 w-full px-4 lg:px-0 text-center sm:text-left">

      {preset === "custom" && (
        <div className="lg:hidden flex flex-col gap-2 card-float p-4 opacity-0 animate-fade-in">
          <p className="text-xs font-medium text-muted-foreground font-body">Custom range</p>
          <div className="flex gap-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-10 rounded-xl border bg-card px-3 text-sm font-body flex-1 min-w-0"
            />
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-10 rounded-xl border bg-card px-3 text-sm font-body flex-1 min-w-0"
            />
          </div>
        </div>
      )}

      {!user?.hasDbRole && (
        <Alert className="rounded-xl border-warning/40 bg-warning/5 text-left opacity-0 animate-fade-in">
          <AlertCircle className="h-4 w-4 text-warning" />
          <AlertTitle className="font-heading">No role record yet</AlertTitle>
          <AlertDescription className="font-body text-sm text-muted-foreground">
            You will not see customers or orders until an administrator adds your account in the Salespersons list.{" "}
            <Link to="/profile" className="text-primary font-medium underline-offset-2 hover:underline">
              Open profile
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <div className="hidden lg:flex flex-col items-center sm:items-start opacity-0 animate-fade-in">
        <div className="h-14 w-14 rounded-2xl gradient-primary flex items-center justify-center mb-3 shadow-md sm:hidden">
          <span className="text-primary-foreground text-lg font-heading font-bold">{user?.initials}</span>
        </div>
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Welcome back, {firstName}</h1>
        <p className="text-muted-foreground font-body text-sm mt-1 max-w-md mx-auto sm:mx-0">
          Your portfolio — customers, orders, and POs assigned to you in Shopify (SP / referred-by metafields).
        </p>
        <Link
          to="/profile"
          className="text-xs text-primary font-medium mt-2 underline-offset-2 hover:underline font-body sm:mx-0 mx-0"
        >
          View profile & account details
        </Link>
      </div>

      <div className="hidden lg:flex card-float p-4 opacity-0 animate-fade-in flex-col sm:flex-row flex-wrap gap-3 items-stretch sm:items-end">
        <div className="flex-1 min-w-[160px]">
          <p className="text-xs font-medium text-muted-foreground font-body mb-1.5">Period</p>
          <Select value={preset} onValueChange={(v) => setPreset(v as DatePreset)}>
            <SelectTrigger className="rounded-xl h-10 font-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <PeriodSelectItems />
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
      </div>

      <DashboardOverviewSummaryCard
        currency={currency}
        delayBase={50}
        salesBreakdown={shopifySalesBreakdown}
        loadingSales={loadingAnalytics}
        totalOrders={totalOrders}
        paidOrders={paidOrders}
        pendingOrders={pendingOrders}
        refundedOrders={refundedOrders}
        unfulfilledOrders={unfulfilledOrders}
        loadingOrders={loadingAnalytics}
        loadingUnfulfilled={loadingAnalytics}
        totalCustomers={totalCustomers}
        loadingCustomers={loadingAnalytics}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        {loadingChart ? (
          <>
            <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Revenue Trend ({trendLabel})</h3>
              <Skeleton className="h-[220px] w-full rounded-xl" />
            </div>
            <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Orders Trend ({trendLabel})</h3>
              <Skeleton className="h-[220px] w-full rounded-xl" />
            </div>
          </>
        ) : hasChartData ? (
          <>
            <div className="card-float p-5 h-full flex flex-col opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Revenue Trend ({trendLabel})</h3>
              <div className="flex-1 min-h-[220px] min-w-0">
                <ResponsiveContainer width="100%" height={220} minWidth={0} minHeight={220}>
                  <BarChart
                    data={chartData}
                    margin={{ top: 6, right: 0, left: 0, bottom: 0 }}
                    barCategoryGap="8%"
                    barGap={0}
                    maxBarSize={40}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      padding={{ left: 0, right: 0 }}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      width={48}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                      tickFormatter={(v) => formatCompactMoney(Number(v), currency)}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid hsl(var(--border))",
                        fontSize: 13,
                      }}
                      formatter={(value: number) => [formatOrderMoney(value, null, currency), "Revenue"]}
                    />
                    <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="card-float p-5 h-full flex flex-col opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Orders Trend ({trendLabel})</h3>
              <div className="flex-1 min-h-[220px]">
                <ResponsiveContainer width="100%" height={220} minWidth={0} minHeight={220}>
                  <AreaChart data={chartData} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dashboardOrdersGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.36} />
                        <stop offset="65%" stopColor="hsl(var(--primary))" stopOpacity={0.14} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.03} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      padding={{ left: 0, right: 0 }}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      width={44}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid hsl(var(--border))", fontSize: 13 }} />
                    <Area
                      type="monotone"
                      dataKey="orders"
                      stroke="hsl(var(--primary))"
                      fill="url(#dashboardOrdersGradient)"
                      fillOpacity={1}
                      strokeWidth={2.5}
                      activeDot={{ r: 4 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Revenue Trend ({trendLabel})</h3>
              <p className="text-muted-foreground text-sm font-body py-12 text-center">No revenue data in this period.</p>
            </div>
            <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Orders Trend ({trendLabel})</h3>
              <p className="text-muted-foreground text-sm font-body py-12 text-center">No order data in this period.</p>
            </div>
          </>
        )}
      </div>

      <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "350ms" }}>
        <h3 className="font-heading font-semibold text-foreground mb-4">Recent Orders</h3>
        {loadingRecentOrders ? (
          <div className="space-y-3 py-1">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        ) : recentOrders.length === 0 ? (
          <p className="text-muted-foreground font-body text-sm text-center py-6">No orders in this period.</p>
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
                  {recentOrders.map((order: { id: string; order_number?: string | null; shopify_order_id?: string; customer_name?: string | null; total?: number | null; currency_code?: string | null; financial_status?: string | null; shopify_created_at?: string | null }) => (
                    <tr key={order.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                      <td className="py-3 font-medium text-foreground">{order.order_number || order.shopify_order_id}</td>
                      <td className="py-3 text-muted-foreground">{order.customer_name}</td>
                      <td className="py-3 text-right font-medium text-foreground">
                        {formatOrderMoney(Number(order.total), order.currency_code, currency)}
                      </td>
                      <td className="py-3">
                        <StatusBadge status={(order.financial_status || "pending") as any} />
                      </td>
                      <td className="py-3 text-muted-foreground">{formatDisplayDate(order.shopify_created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="md:hidden space-y-3">
              {recentOrders.map((order: { id: string; order_number?: string | null; shopify_order_id?: string; customer_name?: string | null; total?: number | null; currency_code?: string | null; financial_status?: string | null }) => (
                <div key={order.id} className="flex items-center justify-between p-3 rounded-xl bg-muted/50 tap-scale">
                  <div>
                    <p className="font-medium text-foreground text-sm">{order.order_number || order.shopify_order_id}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{order.customer_name}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium text-foreground text-sm">
                      {formatOrderMoney(Number(order.total), order.currency_code, currency)}
                    </p>
                    <StatusBadge status={(order.financial_status || "pending") as any} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "400ms" }}>
        <h3 className="font-heading font-semibold text-foreground mb-4">Top Customers</h3>
        {loadingTopCustomers ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : topCustomers.length === 0 ? (
          <p className="text-muted-foreground font-body text-sm text-center py-6">No customers yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {topCustomers.map((customer) => (
              <div key={customer.id} className="flex items-center gap-3 p-3 rounded-xl bg-muted/50 tap-scale">
                <div className="h-10 w-10 rounded-full gradient-primary flex items-center justify-center shrink-0">
                  <span className="text-primary-foreground text-xs font-bold font-heading">
                    {customer.name
                      .split(" ")
                      .map((w) => w[0])
                      .join("")
                      .slice(0, 2)}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-foreground text-sm truncate">{customer.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {customer.total_orders || 0} orders · {formatOrderMoney(Number(customer.total_revenue || 0), null, currency)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
    </>
  );
}
