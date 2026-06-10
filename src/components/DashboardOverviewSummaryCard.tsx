import { AlertTriangle, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { type ScopeShopifySalesBreakdown } from "@/hooks/use-shopify-data";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatOrderMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

function formatDeduction(amount: number, currency: string) {
  if (amount <= 0) return formatOrderMoney(0, null, currency);
  return `−${formatOrderMoney(amount, null, currency)}`;
}

function SummaryColumn({
  title,
  info,
  children,
  className,
}: {
  title: string;
  info?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 flex flex-col", className)}>
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-dashed border-border/80">
        <h3 className="font-heading font-semibold text-foreground text-base sm:text-lg">{title}</h3>
        {info ? (
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/80 hover:text-foreground hover:bg-muted/50"
                  aria-label={`About ${title}`}
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px] text-xs font-body leading-5">
                {info}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
      <div className="flex flex-col flex-1 [&>*:not(:first-child)]:border-t [&>*:not(:first-child)]:border-dashed [&>*:not(:first-child)]:border-border/70">
        {children}
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  loading,
  emphasized,
}: {
  label: string;
  value: ReactNode;
  loading?: boolean;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 py-2.5 sm:py-3",
        emphasized && "pt-3 sm:pt-3.5",
      )}
    >
      <span className="text-sm font-medium text-primary font-body shrink-0">{label}</span>
      {loading ? (
        <Skeleton className={cn("rounded-md shrink-0", emphasized ? "h-8 w-28" : "h-7 w-24")} />
      ) : (
        <span
          className={cn(
            "font-heading tabular-nums text-foreground text-right [overflow-wrap:anywhere]",
            emphasized ? "text-xl sm:text-2xl font-bold" : "text-lg sm:text-xl font-semibold",
          )}
        >
          {value}
        </span>
      )}
    </div>
  );
}

export type DashboardOverviewSummaryCardProps = {
  currency: string;
  delayBase?: number;
  salesBreakdown: Partial<ScopeShopifySalesBreakdown> | null | undefined;
  loadingSales: boolean;
  totalOrders: number;
  paidOrders: number;
  pendingOrders: number;
  refundedOrders: number;
  unfulfilledOrders: number;
  loadingOrders: boolean;
  loadingUnfulfilled?: boolean;
  totalCustomers: number;
  loadingCustomers: boolean;
  unfulfilledHref?: string;
  pendingHref?: string;
};

export function DashboardOverviewSummaryCard({
  currency,
  delayBase = 40,
  salesBreakdown,
  loadingSales,
  totalOrders,
  paidOrders,
  pendingOrders,
  refundedOrders,
  unfulfilledOrders,
  loadingOrders,
  loadingUnfulfilled = false,
  totalCustomers,
  loadingCustomers,
  unfulfilledHref = "/orders?fulfillment=unfulfilled",
  pendingHref = "/orders?status=pending",
}: DashboardOverviewSummaryCardProps) {
  const gross = salesBreakdown?.gross_sales_line_list ?? 0;
  const disc = salesBreakdown?.discounts ?? 0;
  const refunded = salesBreakdown?.returns_refunded ?? 0;
  const net = salesBreakdown?.net_sales_derived ?? 0;
  const ship = salesBreakdown?.shipping ?? 0;
  const returnFees = salesBreakdown?.return_fees ?? 0;
  const tax = salesBreakdown?.taxes ?? 0;
  const totalCheck = salesBreakdown?.total_sales_check ?? 0;
  const missing = salesBreakdown?.orders_missing_reporting ?? 0;

  const ordersInfo =
    "Order counts for the selected period by financial status (paid, pending/authorized, refunded/voided) plus fulfillment (unfulfilled is separate — an order can be paid and unfulfilled).";
  const salesInfo =
    "Shopify Analytics Total sales breakdown (sales event day, Asia/Dubai). Refreshed from ShopifyQL on each order webhook and during scheduled sync. Includes discounts and gross on older orders when Shopify attributes them to this period.";
  const customersInfo = "Scoped registered customers in the selected period (customer created-at filter).";

  return (
    <div
      className="card-float p-4 sm:p-5 space-y-4 opacity-0 animate-fade-in min-w-0"
      style={{ animationDelay: `${delayBase}ms` }}
    >
      {missing > 0 && (
        <Alert className="border-amber-500/40 bg-amber-500/5 text-amber-950 dark:text-amber-100 text-left font-body text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertTitle className="font-heading text-foreground">Incomplete Layer 2 data</AlertTitle>
          <AlertDescription>
            {missing.toLocaleString()} order{missing === 1 ? "" : "s"} missing subtotal or line gross — totals may drift until
            webhook re-processes those orders.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8 lg:divide-x divide-border/70">
        <SummaryColumn title="Total sales breakdown" info={salesInfo} className="lg:pr-6">
          <SummaryRow
            label="Gross sales"
            loading={loadingSales}
            value={formatOrderMoney(gross, null, currency)}
          />
          <SummaryRow label="Discounts" loading={loadingSales} value={formatDeduction(disc, currency)} />
          <SummaryRow label="Returns" loading={loadingSales} value={formatDeduction(refunded, currency)} />
          <SummaryRow label="Net sales" loading={loadingSales} value={formatOrderMoney(net, null, currency)} />
          <SummaryRow label="Shipping charges" loading={loadingSales} value={formatOrderMoney(ship, null, currency)} />
          <SummaryRow label="Return fees" loading={loadingSales} value={formatDeduction(returnFees, currency)} />
          <SummaryRow label="Taxes" loading={loadingSales} value={formatOrderMoney(tax, null, currency)} />
          <SummaryRow
            label="Total sales"
            loading={loadingSales}
            emphasized
            value={formatOrderMoney(totalCheck, null, currency)}
          />
        </SummaryColumn>

        <SummaryColumn title="Orders" info={ordersInfo} className="lg:px-6">
          <SummaryRow label="Total" loading={loadingOrders} value={totalOrders.toLocaleString()} />
          <SummaryRow label="Paid" loading={loadingOrders} value={paidOrders.toLocaleString()} />
          <SummaryRow
            label="Pending"
            loading={loadingOrders}
            value={
              loadingOrders ? (
                "—"
              ) : (
                <Link to={pendingHref} className="text-primary underline-offset-2 hover:underline">
                  {pendingOrders.toLocaleString()}
                </Link>
              )
            }
          />
          <SummaryRow label="Refunded" loading={loadingOrders} value={refundedOrders.toLocaleString()} />
          <SummaryRow
            label="Unfulfilled"
            loading={loadingUnfulfilled}
            value={
              loadingUnfulfilled ? (
                "—"
              ) : (
                <Link
                  to={unfulfilledHref}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {unfulfilledOrders.toLocaleString()}
                </Link>
              )
            }
          />
        </SummaryColumn>

        <SummaryColumn title="Customers" info={customersInfo} className="lg:pl-6">
          <div className="flex flex-col items-center justify-center flex-1 min-h-[120px] lg:min-h-0 text-center">
            <p className="text-sm font-medium font-body mb-2 text-muted-foreground">Registered customers</p>
            {loadingCustomers ? (
              <Skeleton className="h-10 w-20 rounded-md mx-auto" />
            ) : (
              <p className="text-3xl sm:text-4xl font-heading font-bold text-foreground tabular-nums w-full text-center">
                {totalCustomers.toLocaleString()}
              </p>
            )}
          </div>
        </SummaryColumn>
      </div>
    </div>
  );
}
