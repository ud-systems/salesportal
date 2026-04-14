import { DollarSign, ShoppingCart, Users, TrendingUp, AlertCircle } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import { StatusBadge } from "@/components/StatusBadge";
import {
  useCustomersCount,
  useCustomersCountInRange,
  useOrdersCount,
  useOrdersMetricsInRange,
  useOrdersTotalRevenue,
  useRecentOrders,
  useRecentOrdersInRange,
  useRevenueByMonthForYear,
  useOrdersTimeseriesInRange,
  useTopCustomers,
} from "@/hooks/use-shopify-data";
import { useAuth } from "@/contexts/AuthContext";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getDashboardRange, toRangeIso, type DatePreset } from "@/lib/dashboard-date-range";
import { differenceInCalendarDays } from "date-fns";
import { formatOrderMoney, formatDisplayDate, formatCompactMoney } from "@/lib/format";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";

export default function DashboardPage() {
  const { user } = useAuth();
  const scopeKey = user?.id ?? "anonymous";
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

  const { data: totalCustomersAll = 0, isLoading: loadingCustomersAll } = useCustomersCount(scopeKey);
  const { data: totalOrdersAll = 0, isLoading: loadingOrdersAll } = useOrdersCount(scopeKey);
  const { data: totalRevenueAll = 0, isLoading: loadingRevenueAll } = useOrdersTotalRevenue(scopeKey);
  const { data: recentOrdersAll = [], isLoading: loadingRecentAll } = useRecentOrders(5, scopeKey);
  const { data: monthlyRevenue = [], isLoading: loadingRevenueByMonth } = useRevenueByMonthForYear(year, scopeKey);

  const { data: metricsRange, isLoading: loadingMetricsRange } = useOrdersMetricsInRange(
    fromIso,
    toIso,
    scopeKey,
    !isAll,
  );
  const { data: metricsCompare, isLoading: loadingMetricsCompare } = useOrdersMetricsInRange(
    cmpFromIso,
    cmpToIso,
    scopeKey,
    !isAll && Boolean(cmpFromIso && cmpToIso),
  );
  const { data: customersRange = 0, isLoading: loadingCustomersRange } = useCustomersCountInRange(
    fromIso,
    toIso,
    scopeKey,
    !isAll,
  );
  const { data: seriesRange = [], isLoading: loadingSeries } = useOrdersTimeseriesInRange(
    fromIso,
    toIso,
    bucket,
    scopeKey,
    !isAll,
  );
  const { data: recentFiltered = [], isLoading: loadingRecentFiltered } = useRecentOrdersInRange(
    5,
    fromIso,
    toIso,
    scopeKey,
    !isAll,
  );

  const { data: topCustomers = [], isLoading: loadingTopCustomers } = useTopCustomers(3, scopeKey);

  const totalRevenue = isAll ? totalRevenueAll : (metricsRange?.revenue ?? 0);
  const totalOrders = isAll ? totalOrdersAll : (metricsRange?.count ?? 0);
  const totalCustomers = isAll ? totalCustomersAll : customersRange;
  const recentOrders = isAll ? recentOrdersAll : recentFiltered;

  const loadingRevenueTotal = isAll ? loadingRevenueAll : loadingMetricsRange;
  const loadingOrdersCount = isAll ? loadingOrdersAll : loadingMetricsRange;
  const loadingCustomersCount = isAll ? loadingCustomersAll : loadingCustomersRange;
  const loadingRecentOrders = isAll ? loadingRecentAll : loadingRecentFiltered;

  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

  const revenueDataAll = useMemo(() => {
    const months = monthlyRevenue || [];
    const nonZeroMonths = months.filter((m) => Number(m.revenue || 0) > 0 || Number(m.orders || 0) > 0);
    if (nonZeroMonths.length >= 6) return nonZeroMonths.slice(-6);
    if (nonZeroMonths.length > 0) return nonZeroMonths;
    return months.slice(-6);
  }, [monthlyRevenue]);

  const chartData = useMemo(() => {
    if (isAll) {
      return revenueDataAll.map((m) => ({
        label: m.month,
        revenue: m.revenue,
        orders: m.orders,
      }));
    }
    return seriesRange.map((p) => ({ label: p.label, revenue: p.revenue, orders: p.orders }));
  }, [isAll, revenueDataAll, seriesRange]);
  const hasChartData = useMemo(
    () => chartData.some((point) => Number(point.revenue || 0) > 0 || Number(point.orders || 0) > 0),
    [chartData],
  );

  const loadingChart = isAll ? loadingRevenueByMonth : loadingSeries;

  const prevRevenue = metricsCompare?.revenue ?? 0;
  const revDelta =
    !isAll && prevRevenue > 0 ? (((totalRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1) : null;

  const firstName = user?.name?.split(" ")[0] || "there";

  return (
    <div className="space-y-6 w-full text-center sm:text-left">
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

      <div className="flex flex-col items-center sm:items-start opacity-0 animate-fade-in">
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
            Compared to previous equivalent period
            {loadingMetricsCompare ? "" : revDelta != null ? ` · Revenue ${Number(revDelta) >= 0 ? "+" : ""}${revDelta}%` : ""}
          </p>
        )}
      </div>

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
          title="Orders"
          value={loadingOrdersCount ? <Skeleton className="h-8 w-16 rounded-md" /> : totalOrders.toString()}
          icon={ShoppingCart}
          delay={100}
        />
        <KpiCard
          title="Customers"
          value={loadingCustomersCount ? <Skeleton className="h-8 w-16 rounded-md" /> : totalCustomers.toString()}
          icon={Users}
          delay={150}
        />
        <KpiCard
          title="Avg. Order"
          value={
            loadingRevenueTotal || loadingOrdersCount ? (
              <Skeleton className="h-8 w-20 rounded-md" />
            ) : (
              formatOrderMoney(avgOrderValue, null, currency)
            )
          }
          icon={TrendingUp}
          delay={200}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        {loadingChart ? (
          <>
            <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Revenue</h3>
              <Skeleton className="h-[220px] w-full rounded-xl" />
            </div>
            <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Orders trend</h3>
              <Skeleton className="h-[220px] w-full rounded-xl" />
            </div>
          </>
        ) : hasChartData ? (
          <>
            <div className="card-float p-5 h-full flex flex-col opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Revenue</h3>
              <div className="flex-1 min-h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
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
              <h3 className="font-heading font-semibold text-foreground mb-4">Orders trend</h3>
              <div className="flex-1 min-h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
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
                      fill="hsl(var(--primary) / 0.15)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Revenue</h3>
              <p className="text-muted-foreground text-sm font-body py-12 text-center">No revenue data in this period.</p>
            </div>
            <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Orders trend</h3>
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
  );
}
