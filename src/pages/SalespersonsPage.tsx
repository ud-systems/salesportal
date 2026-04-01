import { useCustomers } from "@/hooks/use-shopify-data";
import { Users, DollarSign } from "lucide-react";
import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";

function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2);
}

export default function SalespersonsPage() {
  const { data: customers, isLoading } = useCustomers();

  // Derive salesperson summaries from customers (admin sees all)
  const salespersons = useMemo(() => {
    const map: Record<string, { name: string; customers: number; revenue: number }> = {};
    for (const c of customers || []) {
      if (c.sp_assigned && c.sp_assigned !== "Unassigned") {
        if (!map[c.sp_assigned]) map[c.sp_assigned] = { name: c.sp_assigned, customers: 0, revenue: 0 };
        map[c.sp_assigned].customers++;
        map[c.sp_assigned].revenue += Number(c.total_revenue || 0);
      }
    }
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }, [customers]);

  return (
    <div className="space-y-5 max-w-[1200px]">
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
      ) : salespersons.length === 0 ? (
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
                    <th className="text-right py-2.5 font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {salespersons.map((sp, i) => (
                    <tr
                      key={sp.name}
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
                      <td className="py-3 text-right font-medium text-foreground">${Number(sp.revenue).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="md:hidden space-y-3">
            {salespersons.map((sp, i) => (
              <div key={sp.name} className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: `${50 + i * 80}ms` }}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-12 w-12 rounded-full gradient-primary flex items-center justify-center shrink-0">
                    <span className="text-primary-foreground text-sm font-bold font-heading">{initials(sp.name)}</span>
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-heading font-semibold text-foreground truncate">{sp.name}</h3>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1 p-3 rounded-xl bg-muted/50 text-center">
                    <Users className="h-4 w-4 text-primary mx-auto mb-1" />
                    <p className="text-lg font-heading font-bold text-foreground">{sp.customers}</p>
                    <p className="text-[10px] text-muted-foreground font-body">Customers</p>
                  </div>
                  <div className="flex-1 p-3 rounded-xl bg-muted/50 text-center">
                    <DollarSign className="h-4 w-4 text-primary mx-auto mb-1" />
                    <p className="text-lg font-heading font-bold text-foreground">${(sp.revenue / 1000).toFixed(0)}k</p>
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
