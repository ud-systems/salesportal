import { useSalespersonPerformance } from "@/hooks/use-shopify-data";
import { Users, PoundSterling } from "lucide-react";
import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatOrderMoney } from "@/lib/format";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";

function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
}

export default function SalespersonsPage() {
  const { data: storeCurrency = "GBP" } = useShopDisplayCurrency();
  const { data: salespersons = [], isLoading } = useSalespersonPerformance("admin");

  const rows = useMemo(
    () =>
      salespersons.map((sp) => ({
        key: sp.salesperson_user_id,
        name: sp.salesperson_name,
        customers: Number(sp.customers_count || 0),
        orders: Number(sp.orders_count || 0),
        revenue: Number(sp.revenue || 0),
      })),
    [salespersons],
  );

  return (
    <div className="w-full space-y-5">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Salespersons</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">Sales team performance</p>
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
                    <th className="text-right py-2.5 font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((sp, i) => (
                    <tr
                      key={sp.key}
                      className="border-b last:border-0 hover:bg-muted/50 transition-colors opacity-0 animate-fade-in"
                      style={{ animationDelay: `${100 + i * 40}ms` }}
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
                      <td className="py-3 text-right font-medium text-foreground">{formatOrderMoney(Number(sp.revenue), null, storeCurrency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="md:hidden space-y-3">
            {rows.map((sp, i) => (
              <div key={sp.key} className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: `${50 + i * 80}ms` }}>
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
                    <p className="text-lg font-heading font-bold text-foreground">{formatOrderMoney(Number(sp.revenue), null, storeCurrency)}</p>
                    <p className="text-[10px] text-muted-foreground font-body">Revenue</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
