import { DollarSign, ShoppingCart, Users, PackageX } from "lucide-react";
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
import { useMemo } from "react";
import { CardGridSkeleton, HeaderSkeleton, TableSkeleton } from "@/components/PageSkeletons";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
const COLORS = ["hsl(100, 42%, 45%)", "hsl(100, 50%, 50%)", "hsl(40, 96%, 60%)", "hsl(210, 80%, 55%)", "hsl(0, 70%, 55%)"];

export default function AdminDashboardPage() {
  const year = new Date().getUTCFullYear();
  const { data: customers, isLoading: loadingCustomers } = useCustomers();
  const { data: totalOrders = 0, isLoading: loadingOrdersCount } = useOrdersCount();
  const { data: totalCustomers = 0, isLoading: loadingCustomersCount } = useCustomersCount();
  const { data: totalRevenue = 0, isLoading: loadingRevenueTotal } = useOrdersTotalRevenue();
  const { data: unfulfilledOrders = 0, isLoading: loadingUnfulfilled } = useUnfulfilledOrdersCount();
  const { data: recentOrders = [], isLoading: loadingRecentOrders } = useRecentOrders(10);
  const { data: revenueData = [], isLoading: loadingRevenue } = useRevenueByMonthForYear(year);

  const salesBySP = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of customers || []) {
      if (c.sp_assigned && c.sp_assigned !== "Unassigned") {
        map[c.sp_assigned] = (map[c.sp_assigned] || 0) + Number(c.total_revenue || 0);
      }
    }
    return Object.entries(map).map(([name, revenue]) => ({ name: name.split(" ")[0], fullName: name, revenue }));
  }, [customers]);

  if (loadingOrdersCount || loadingCustomersCount || loadingRevenueTotal || loadingUnfulfilled || loadingRecentOrders || loadingRevenue) {
    return <div className="space-y-6 max-w-[1200px]"><HeaderSkeleton /><CardGridSkeleton cards={4} /><TableSkeleton rows={3} cols={4} /></div>;
  }

  return (
    <div className="space-y-6 max-w-[1200px]">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Admin Dashboard</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">Organization-wide overview</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
        <KpiCard title="Total Revenue" value={`$${totalRevenue.toLocaleString()}`} icon={DollarSign} delay={50} />
        <KpiCard title="Total Orders" value={totalOrders.toString()} icon={ShoppingCart} delay={100} />
        <KpiCard title="Total Customers" value={totalCustomers.toString()} icon={Users} delay={150} />
        <Link to="/orders?fulfillment=unfulfilled" className="block">
          <KpiCard title="Unfulfilled Orders" value={unfulfilledOrders.toString()} icon={PackageX} delay={200} />
        </Link>
      </div>

      <div className={`grid grid-cols-1 gap-4 ${salesBySP.length > 0 ? "lg:grid-cols-2" : ""}`}>
        <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "250ms" }}>
          <h3 className="font-heading font-semibold text-foreground mb-4">Revenue by Month ({revenueData[0]?.year || year})</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={revenueData} margin={{ top: 6, right: 0, left: 0, bottom: 0 }} barCategoryGap="22%">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="month" padding={{ left: 0, right: 0 }} tick={{ fontSize: 12, fontFamily: 'Inter Tight' }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
              <YAxis width={40} tick={{ fontSize: 12, fontFamily: 'Inter Tight' }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', fontFamily: 'Inter Tight', fontSize: 13 }} formatter={(value: number) => [`$${value.toLocaleString()}`, "Revenue"]} />
              <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {!loadingCustomers && salesBySP.length > 0 && (
          <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "300ms" }}>
            <h3 className="font-heading font-semibold text-foreground mb-4">Sales by Salesperson</h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={salesBySP} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="revenue" nameKey="name">
                  {salesBySP.map((_, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid hsl(var(--border))", fontFamily: "Inter Tight", fontSize: 13 }} formatter={(value: number) => `$${value.toLocaleString()}`} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap justify-center gap-3 mt-2">
              {salesBySP.map((sp, i) => (
                <div key={sp.fullName} className="flex items-center gap-1.5 text-xs font-body text-muted-foreground">
                  <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                  {sp.name}
                </div>
              ))}
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
                  const custCount = (customers || []).filter((c) => c.sp_assigned === sp.fullName).length;
                  return (
                    <tr key={sp.fullName} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                      <td className="py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-full gradient-primary flex items-center justify-center">
                            <span className="text-primary-foreground text-[10px] font-bold font-heading">{sp.fullName.split(" ").map((w) => w[0]).join("")}</span>
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
              const custCount = (customers || []).filter((c) => c.sp_assigned === sp.fullName).length;
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
        {recentOrders.length === 0 ? (
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
