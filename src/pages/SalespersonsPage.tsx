import { useCustomersPaginated, useOrdersPaginated, useSalespersonFinancialBreakdown } from "@/hooks/use-shopify-data";
import { Users, PoundSterling } from "lucide-react";
import { useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDisplayDate, formatOrderMoney } from "@/lib/format";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getDashboardRange, toLocalYmd, toRangeIso, type DatePreset } from "@/lib/dashboard-date-range";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";

function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
}

export default function SalespersonsPage() {
  const { data: storeCurrency = "GBP" } = useShopDisplayCurrency();
  const [preset, setPreset] = useState<DatePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const range = useMemo(
    () => getDashboardRange(preset, customFrom || undefined, customTo || undefined),
    [preset, customFrom, customTo],
  );
  const isAll = preset === "all";
  const fromIso = toRangeIso(range.from);
  const toIso = toRangeIso(range.to);
  const fromYmd = toLocalYmd(range.from);
  const toYmd = toLocalYmd(range.to);
  const [selectedSalesperson, setSelectedSalesperson] = useState<{ id: string; name: string } | null>(null);
  const { data: salespersons = [], isLoading } = useSalespersonFinancialBreakdown(
    "admin",
    isAll ? null : fromIso,
    isAll ? null : toIso,
  );

  const rows = useMemo(
    () =>
      salespersons.map((sp) => ({
        key: sp.salesperson_user_id,
        name: sp.salesperson_name,
        customers: Number(sp.customers_count || 0),
        orders: Number(sp.orders_total_count || 0),
        paidOrders: Number(sp.orders_paid_count || 0),
        refundedOrders: Number(sp.orders_refunded_count || 0),
        grossRevenue: Number(sp.gross_revenue || 0),
        refundAmount: Number(sp.refunded_amount || 0),
        netRevenue: Number(sp.net_revenue || 0),
      })),
    [salespersons],
  );
  const selectedSalespersonId = selectedSalesperson?.id;
  const { data: selectedCustomersData, isLoading: loadingSelectedCustomers } = useCustomersPaginated({
    page: 1,
    pageSize: 8,
    fromDate: fromYmd,
    toDate: toYmd,
    scopeSalespersonIds: selectedSalespersonId ? [selectedSalespersonId] : [],
    forceScopedFilter: true,
    enabled: Boolean(selectedSalespersonId),
  });
  const { data: selectedOrdersData, isLoading: loadingSelectedOrders } = useOrdersPaginated({
    page: 1,
    pageSize: 8,
    fromDate: fromYmd,
    toDate: toYmd,
    sortBy: "shopify_created_at",
    sortDir: "desc",
    scopeSalespersonIds: selectedSalespersonId ? [selectedSalespersonId] : [],
    forceScopedFilter: true,
    enabled: Boolean(selectedSalespersonId),
  });
  const selectedCustomers = selectedCustomersData?.data ?? [];
  const selectedOrders = selectedOrdersData?.data ?? [];
  const selectedCustomersCount = selectedCustomersData?.count ?? 0;
  const selectedOrdersCount = selectedOrdersData?.count ?? 0;

  return (
    <div className="w-full space-y-5">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Salespersons</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">Sales team performance</p>
      </div>

      <div className={`grid grid-cols-1 gap-2 ${preset === "custom" ? "md:grid-cols-3" : "md:grid-cols-1"} opacity-0 animate-fade-in`} style={{ animationDelay: "60ms" }}>
        <Select value={preset} onValueChange={(v) => setPreset(v as DatePreset)}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Period" />
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
        {preset === "custom" && (
          <>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
          </>
        )}
      </div>

      {isLoading ? (
        <>
          <div className="hidden md:block card-float p-5 opacity-0 animate-fade-in">
            <div className="space-y-3">
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-9 w-full rounded-lg" />
            </div>
          </div>
          <div className="md:hidden grid grid-cols-1 gap-4">
            <div className="card-float p-5">
              <Skeleton className="h-32 w-full rounded-xl" />
            </div>
            <div className="card-float p-5">
              <Skeleton className="h-32 w-full rounded-xl" />
            </div>
          </div>
        </>
      ) : rows.length === 0 ? (
        <div className="card-float p-10 text-center opacity-0 animate-fade-in">
          <p className="text-muted-foreground font-body">No salesperson data. Sync customers from Shopify first.</p>
        </div>
      ) : (
        <>
          <div className="hidden md:block card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-body">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2.5 font-medium">Salesperson</th>
                    <th className="text-right py-2.5 font-medium">Customers</th>
                    <th className="text-right py-2.5 font-medium">Orders</th>
                    <th className="text-right py-2.5 font-medium">Paid</th>
                    <th className="text-right py-2.5 font-medium">Refunded</th>
                    <th className="text-right py-2.5 font-medium">Gross</th>
                    <th className="text-right py-2.5 font-medium">Refund Amt</th>
                    <th className="text-right py-2.5 font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((sp, i) => (
                    <tr
                      key={sp.key}
                      className="border-b last:border-0 hover:bg-muted/50 transition-colors opacity-0 animate-fade-in cursor-pointer"
                      style={{ animationDelay: `${100 + i * 40}ms` }}
                      onClick={() => setSelectedSalesperson({ id: sp.key, name: sp.name })}
                    >
                      <td className="py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-full gradient-primary flex items-center justify-center shrink-0">
                            <span className="text-primary-foreground text-xs font-bold font-heading">{initials(sp.name)}</span>
                          </div>
                          <span className="font-medium text-foreground font-heading">{sp.name}</span>
                        </div>
                      </td>
                      <td className="py-3 text-right font-medium text-foreground">{sp.customers}</td>
                      <td className="py-3 text-right font-medium text-foreground">{sp.orders}</td>
                      <td className="py-3 text-right font-medium text-foreground">{sp.paidOrders}</td>
                      <td className="py-3 text-right font-medium text-foreground">{sp.refundedOrders}</td>
                      <td className="py-3 text-right font-medium text-foreground">{formatOrderMoney(Number(sp.grossRevenue), null, storeCurrency)}</td>
                      <td className="py-3 text-right font-medium text-foreground">{formatOrderMoney(Number(sp.refundAmount), null, storeCurrency)}</td>
                      <td className="py-3 text-right font-medium text-foreground">{formatOrderMoney(Number(sp.netRevenue), null, storeCurrency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="md:hidden space-y-3">
            {rows.map((sp, i) => (
              <div
                key={sp.key}
                className="card-float p-5 opacity-0 animate-fade-in cursor-pointer"
                style={{ animationDelay: `${50 + i * 80}ms` }}
                onClick={() => setSelectedSalesperson({ id: sp.key, name: sp.name })}
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-12 w-12 rounded-full gradient-primary flex items-center justify-center shrink-0">
                    <span className="text-primary-foreground text-sm font-bold font-heading">{initials(sp.name)}</span>
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-heading font-semibold text-foreground truncate">{sp.name}</h3>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="flex-1 p-3 rounded-xl bg-muted/50 text-center">
                    <Users className="h-4 w-4 text-primary mx-auto mb-1" />
                    <p className="text-lg font-heading font-bold text-foreground">{sp.customers}</p>
                    <p className="text-[10px] text-muted-foreground font-body">Customers</p>
                  </div>
                  <div className="flex-1 p-3 rounded-xl bg-muted/50 text-center">
                    <Users className="h-4 w-4 text-primary mx-auto mb-1" />
                    <p className="text-lg font-heading font-bold text-foreground">{sp.orders}</p>
                    <p className="text-[10px] text-muted-foreground font-body">Orders</p>
                  </div>
                  <div className="flex-1 p-3 rounded-xl bg-muted/50 text-center">
                    <PoundSterling className="h-4 w-4 text-primary mx-auto mb-1" />
                    <p className="text-lg font-heading font-bold text-foreground">{formatOrderMoney(Number(sp.netRevenue), null, storeCurrency)}</p>
                    <p className="text-[10px] text-muted-foreground font-body">Net Revenue</p>
                  </div>
                </div>
                <div className="mt-3 flex justify-between text-[11px] text-muted-foreground font-body">
                  <span>Gross: {formatOrderMoney(Number(sp.grossRevenue), null, storeCurrency)}</span>
                  <span>Refund: {formatOrderMoney(Number(sp.refundAmount), null, storeCurrency)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <Sheet open={Boolean(selectedSalesperson)} onOpenChange={(open) => !open && setSelectedSalesperson(null)}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selectedSalesperson?.name || "Salesperson"} drilldown</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-4 font-body text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">Customers in period</p>
                <p className="text-lg font-heading font-bold text-foreground">{selectedCustomersCount}</p>
              </div>
              <div className="rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">Orders in period</p>
                <p className="text-lg font-heading font-bold text-foreground">{selectedOrdersCount}</p>
              </div>
            </div>

            <div className="rounded-xl border p-4">
              <p className="text-sm font-semibold text-foreground mb-3">Customers added in selected period</p>
              {loadingSelectedCustomers ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full rounded-lg" />
                  <Skeleton className="h-10 w-full rounded-lg" />
                  <Skeleton className="h-10 w-full rounded-lg" />
                </div>
              ) : selectedCustomers.length === 0 ? (
                <p className="text-muted-foreground">No customers found for this period.</p>
              ) : (
                <div className="space-y-2">
                  {selectedCustomers.map((c: any) => (
                    <div key={c.id} className="rounded-lg border bg-muted/20 px-3 py-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-foreground font-medium truncate">{c.name || "Unnamed customer"}</p>
                        <p className="text-xs text-muted-foreground truncate">{c.email || "No email"}{c.city ? ` · ${c.city}` : ""}</p>
                      </div>
                      <p className="text-xs text-muted-foreground whitespace-nowrap">{formatDisplayDate(c.shopify_created_at || c.created_at)}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border p-4">
              <p className="text-sm font-semibold text-foreground mb-3">Orders made in selected period</p>
              {loadingSelectedOrders ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full rounded-lg" />
                  <Skeleton className="h-10 w-full rounded-lg" />
                  <Skeleton className="h-10 w-full rounded-lg" />
                </div>
              ) : selectedOrders.length === 0 ? (
                <p className="text-muted-foreground">No orders found for this period.</p>
              ) : (
                <div className="space-y-2">
                  {selectedOrders.map((order: any) => (
                    <div key={order.id} className="rounded-lg border bg-muted/20 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-foreground font-medium">{order.order_number || order.shopify_order_id || "Order"}</p>
                        <p className="text-foreground font-semibold">{formatOrderMoney(Number(order.total || 0), order.currency_code, storeCurrency)}</p>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <p className="text-xs text-muted-foreground truncate">{order.customer_name || "Unknown customer"}</p>
                        <p className="text-xs text-muted-foreground whitespace-nowrap">{formatDisplayDate(order.shopify_created_at || order.created_at)}</p>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <StatusBadge status={(order.financial_status || "pending") as any} />
                        <StatusBadge status={(order.fulfillment_status || "unfulfilled") as any} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <SheetClose asChild>
                <Button variant="outline" className="rounded-xl">Close</Button>
              </SheetClose>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
