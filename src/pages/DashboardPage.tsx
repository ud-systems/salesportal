import { DollarSign, ShoppingCart, Users, TrendingUp, AlertCircle } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import { StatusBadge } from "@/components/StatusBadge";
import {
  useCustomersCount,
  useOrdersCount,
  useOrdersTotalRevenue,
  useRecentOrders,
  useRevenueByMonthForYear,
  useTopCustomers,
} from "@/hooks/use-shopify-data";
import { useAuth } from "@/contexts/AuthContext";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardPage() {
  const { user } = useAuth();
  const year = new Date().getUTCFullYear();
  const { data: totalCustomers = 0, isLoading: loadingCustomersCount } = useCustomersCount();
  const { data: totalOrders = 0, isLoading: loadingOrdersCount } = useOrdersCount();
  const { data: totalRevenue = 0, isLoading: loadingRevenueTotal } = useOrdersTotalRevenue();
  const { data: recentOrders = [], isLoading: loadingRecentOrders } = useRecentOrders(5);
  const { data: monthlyRevenue = [], isLoading: loadingRevenueByMonth } = useRevenueByMonthForYear(year);
  const { data: topCustomers = [], isLoading: loadingTopCustomers } = useTopCustomers(3);

  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

  const revenueData = useMemo(() => {
    return (monthlyRevenue || []).slice(-6);
  }, [monthlyRevenue]);

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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
        <KpiCard
          title="Total Revenue"
          value={loadingRevenueTotal ? <Skeleton className="h-8 w-24 rounded-md" /> : `$${totalRevenue.toLocaleString()}`}
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
          value={loadingRevenueTotal || loadingOrdersCount ? <Skeleton className="h-8 w-20 rounded-md" /> : `$${avgOrderValue.toLocaleString()}`}
          icon={TrendingUp}
          delay={200}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {loadingRevenueByMonth ? (
          <>
            <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Revenue</h3>
              <Skeleton className="h-[220px] w-full rounded-xl" />
            </div>
            <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
              <h3 className="font-heading font-semibold text-foreground mb-4">Orders Trend</h3>
              <Skeleton className="h-[220px] w-full rounded-xl" />
            </div>
          </>
        ) : revenueData.length > 0 ? (
          <>
          <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
            <h3 className="font-heading font-semibold text-foreground mb-4">Revenue</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fontFamily: 'Inter Tight' }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 12, fontFamily: 'Inter Tight' }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `$${v / 1000}k`} />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', fontFamily: 'Inter Tight', fontSize: 13 }} formatter={(value: number) => [`$${value.toLocaleString()}`, "Revenue"]} />
                <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
            <h3 className="font-heading font-semibold text-foreground mb-4">Orders Trend</h3>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fontFamily: 'Inter Tight' }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 12, fontFamily: 'Inter Tight' }} stroke="hsl(var(--muted-foreground))" />
                <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', fontFamily: 'Inter Tight', fontSize: 13 }} />
                <Area type="monotone" dataKey="orders" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.15)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          </>
        ) : null}
      </div>

      {/* Recent Orders */}
      <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "350ms" }}>
        <h3 className="font-heading font-semibold text-foreground mb-4">Recent Orders</h3>
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
                <thead><tr className="border-b text-muted-foreground"><th className="text-left py-2.5 font-medium">Order</th><th className="text-left py-2.5 font-medium">Customer</th><th className="text-right py-2.5 font-medium">Amount</th><th className="text-left py-2.5 font-medium">Status</th><th className="text-left py-2.5 font-medium">Date</th></tr></thead>
                <tbody>
                  {recentOrders.map((order) => (
                    <tr key={order.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                      <td className="py-3 font-medium text-foreground">{order.order_number || order.shopify_order_id}</td>
                      <td className="py-3 text-muted-foreground">{order.customer_name}</td>
                      <td className="py-3 text-right font-medium text-foreground">${Number(order.total).toLocaleString()}</td>
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
                    <p className="font-medium text-foreground text-sm">${Number(order.total).toLocaleString()}</p>
                    <StatusBadge status={(order.financial_status || "pending") as any} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Top Customers */}
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
                    {customer.name.split(' ').map(w => w[0]).join('').slice(0, 2)}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-foreground text-sm truncate">{customer.name}</p>
                  <p className="text-xs text-muted-foreground">{customer.total_orders || 0} orders · ${Number(customer.total_revenue || 0).toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
