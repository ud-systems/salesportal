import { ShoppingCart, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface OrdersMetricsGroupCardProps {
  total: number;
  paid: number;
  refundedOrders: number;
  unfulfilled: number;
  loading?: boolean;
  loadingUnfulfilled?: boolean;
  delay?: number;
  unfulfilledHref?: string;
}

export function OrdersMetricsGroupCard({
  total,
  paid,
  refundedOrders,
  unfulfilled,
  loading,
  loadingUnfulfilled,
  delay = 0,
  unfulfilledHref = "/orders?fulfillment=unfulfilled",
}: OrdersMetricsGroupCardProps) {
  const info =
    "Order counts for the selected period: all orders, paid or partially paid, financial status refunded/partially_refunded/voided, and line items not yet fulfilled.";

  const Cell = ({
    label,
    value,
    cellLoading,
    valueClassName,
    href,
  }: {
    label: string;
    value: ReactNode;
    cellLoading?: boolean;
    valueClassName?: string;
    href?: string;
  }) => {
    const inner = (
      <div className={`min-w-0 ${href ? "rounded-lg transition-colors hover:bg-muted/40 -m-1 p-1" : ""}`}>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-body mb-1">{label}</p>
        {cellLoading ? (
          <Skeleton className="h-7 w-14 rounded-md" />
        ) : (
          <p className={`text-lg sm:text-xl font-heading font-bold text-foreground tabular-nums ${valueClassName ?? ""}`}>
            {value}
          </p>
        )}
      </div>
    );
    if (href) {
      return (
        <Link to={href} className="block text-left">
          {inner}
        </Link>
      );
    }
    return inner;
  };

  return (
    <div
      className="card-kpi tap-scale opacity-0 animate-fade-in min-w-0"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <ShoppingCart className="h-5 w-5 text-primary" />
        </div>
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground/80 hover:text-foreground hover:bg-muted/50"
                aria-label="Explain order metrics"
              >
                <Info className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[300px] text-xs font-body leading-5">
              {info}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <p className="text-sm text-muted-foreground font-body mb-3">Orders</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-3">
        <Cell label="Total" value={total} cellLoading={loading} />
        <Cell label="Paid" value={paid} cellLoading={loading} />
        <Cell label="Refunded" value={refundedOrders} cellLoading={loading} />
        <Cell
          label="Unfulfilled"
          value={unfulfilled}
          cellLoading={loadingUnfulfilled}
          href={unfulfilledHref}
          valueClassName="text-primary underline-offset-2 hover:underline"
        />
      </div>
    </div>
  );
}
