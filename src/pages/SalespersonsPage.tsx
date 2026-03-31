import { useCustomers } from "@/hooks/use-shopify-data";
import { Users, DollarSign } from "lucide-react";
import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export default function SalespersonsPage() {
  const { data: customers, isLoading } = useCustomers();

  // Derive salesperson summaries from customers (admin sees all)
  const salespersons = useMemo(() => {
    const map: Record<string, { name: string; customers: number; revenue: number }> = {};
    for (const c of (customers || [])) {
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="card-float p-5"><Skeleton className="h-32 w-full rounded-xl" /></div>
          <div className="card-float p-5"><Skeleton className="h-32 w-full rounded-xl" /></div>
        </div>
      ) : salespersons.length === 0 ? (
        <div className="card-float p-10 text-center opacity-0 animate-fade-in"><p className="text-muted-foreground font-body">No salesperson data. Sync customers from Shopify first.</p></div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {salespersons.map((sp, i) => (
            <div key={sp.name} className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: `${50 + i * 80}ms` }}>
              <div className="flex items-center gap-3 mb-4">
                <div className="h-12 w-12 rounded-full gradient-primary flex items-center justify-center">
                  <span className="text-primary-foreground text-sm font-bold font-heading">{sp.name.split(" ").map(w => w[0]).join("").slice(0, 2)}</span>
                </div>
                <div>
                  <h3 className="font-heading font-semibold text-foreground">{sp.name}</h3>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-xl bg-muted/50 text-center">
                  <Users className="h-4 w-4 text-primary mx-auto mb-1" />
                  <p className="text-lg font-heading font-bold text-foreground">{sp.customers}</p>
                  <p className="text-[10px] text-muted-foreground font-body">Customers</p>
                </div>
                <div className="p-3 rounded-xl bg-muted/50 text-center">
                  <DollarSign className="h-4 w-4 text-primary mx-auto mb-1" />
                  <p className="text-lg font-heading font-bold text-foreground">${(sp.revenue / 1000).toFixed(0)}k</p>
                  <p className="text-[10px] text-muted-foreground font-body">Revenue</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
