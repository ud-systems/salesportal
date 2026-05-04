import { PoundSterling, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatOrderMoney } from "@/lib/format";

interface GrossNetRevenueCardProps {
  gross: number;
  net: number;
  currency: string;
  loading?: boolean;
  delay?: number;
  /** Shown next to the primary (net) figure */
  title?: string;
  info?: ReactNode;
}

export function GrossNetRevenueCard({
  gross,
  net,
  currency,
  loading,
  delay = 0,
  title = "Revenue",
  info = (
    <>
      <span className="font-medium text-foreground">Net</span> is current order totals after returns (Shopify currentTotal).
      <span className="block mt-1">
        <span className="font-medium text-foreground">Gross</span> is original totals before returns (totalPriceSet).
      </span>
    </>
  ),
}: GrossNetRevenueCardProps) {
  return (
    <div
      className="card-kpi tap-scale opacity-0 animate-fade-in min-w-0"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <PoundSterling className="h-5 w-5 text-primary" />
        </div>
      </div>
      <div className="min-w-0 space-y-1">
        {loading ? (
          <>
            <Skeleton className="h-9 w-36 max-w-full rounded-md" />
            <Skeleton className="h-5 w-28 max-w-full rounded-md" />
          </>
        ) : (
          <>
            <p className="text-2xl sm:text-3xl font-heading font-bold text-foreground leading-tight [overflow-wrap:anywhere]">
              {formatOrderMoney(net, null, currency)}
            </p>
            <p className="text-sm text-muted-foreground font-body [overflow-wrap:anywhere]">
              Gross {formatOrderMoney(gross, null, currency)}
            </p>
          </>
        )}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <p className="text-sm text-muted-foreground font-body">{title}</p>
        {info ? (
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground/80 hover:text-foreground"
                  aria-label={`Explain ${title}`}
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
    </div>
  );
}
