import { AlertTriangle, Calculator, CircleDollarSign, Package, Percent, Receipt, RotateCcw, Truck } from "lucide-react";
import { type ScopeShopifySalesBreakdown } from "@/hooks/use-shopify-data";
import { KpiCard } from "@/components/KpiCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatOrderMoney } from "@/lib/format";

export type ShopifySalesBreakdownSectionProps = {
  breakdown: Partial<ScopeShopifySalesBreakdown> | null | undefined;
  loading: boolean;
  currency: string;
  delayBase?: number;
};

export function ShopifySalesBreakdownSection({
  breakdown,
  loading,
  currency,
  delayBase = 0,
}: ShopifySalesBreakdownSectionProps) {
  const gross = breakdown?.gross_sales_line_list ?? 0;
  const disc = breakdown?.discounts ?? 0;
  const refunded = breakdown?.returns_refunded ?? 0;
  const net = breakdown?.net_sales_derived ?? 0;
  const ship = breakdown?.shipping ?? 0;
  const tax = breakdown?.taxes ?? 0;
  const totalCheck = breakdown?.total_sales_check ?? 0;
  const missing = breakdown?.orders_missing_reporting ?? 0;

  return (
    <div className="space-y-3 opacity-0 animate-fade-in" style={{ animationDelay: `${delayBase}ms` }}>
      {missing > 0 && (
        <Alert className="border-amber-500/40 bg-amber-500/5 text-amber-950 dark:text-amber-100 text-left font-body text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertTitle className="font-heading text-foreground">Incomplete Layer 2 data</AlertTitle>
          <AlertDescription>
            Some orders fall back to subtotal for gross until <code className="text-xs">reporting_line_items_gross</code> is
            populated. Deploy updated sync/webhook functions and re-process orders for full discount and shipping accuracy.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 lg:gap-4">
        <KpiCard
          title="Gross sales (line list)"
          value={loading ? <Skeleton className="h-8 w-28 rounded-md" /> : formatOrderMoney(gross, null, currency)}
          icon={Package}
          delay={delayBase + 40}
          info="Shopify Analytics gross sales for the period (ShopifyQL sales event day). Falls back to order subtotals when period facts are not synced."
        />
        <KpiCard
          title="Discounts"
          value={loading ? <Skeleton className="h-8 w-24 rounded-md" /> : formatOrderMoney(disc, null, currency)}
          icon={Percent}
          delay={delayBase + 80}
          info="Shopify Analytics discounts for the period (includes adjustments on orders placed on earlier days)."
        />
        <KpiCard
          title="Returns / refunded"
          value={loading ? <Skeleton className="h-8 w-24 rounded-md" /> : formatOrderMoney(refunded, null, currency)}
          icon={RotateCcw}
          delay={delayBase + 120}
          info="Sum of Shopify Order.totalRefundedSet — Analytics-style returns total, distinct from the retail KPI refund slice."
        />
        <KpiCard
          title="Net sales (derived)"
          value={loading ? <Skeleton className="h-8 w-28 rounded-md" /> : formatOrderMoney(net, null, currency)}
          icon={Calculator}
          delay={delayBase + 160}
          info="Shopify Analytics net merchandise sales for the period."
        />
        <KpiCard
          title="Shipping"
          value={loading ? <Skeleton className="h-8 w-24 rounded-md" /> : formatOrderMoney(ship, null, currency)}
          icon={Truck}
          delay={delayBase + 200}
          info="Sum of Shopify Order.currentShippingPriceSet at last sync."
        />
        <KpiCard
          title="Taxes"
          value={loading ? <Skeleton className="h-8 w-24 rounded-md" /> : formatOrderMoney(tax, null, currency)}
          icon={Receipt}
          delay={delayBase + 240}
          info="Shopify Analytics taxes for the period (from ShopifyQL, not a flat 20% estimate)."
        />
        <KpiCard
          title="Total sales (check)"
          value={loading ? <Skeleton className="h-8 w-28 rounded-md" /> : formatOrderMoney(totalCheck, null, currency)}
          icon={CircleDollarSign}
          delay={delayBase + 280}
          info="Shopify Analytics total sales for the period (net + taxes + shipping − return fees)."
        />
      </div>
    </div>
  );
}
