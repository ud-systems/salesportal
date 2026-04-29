import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Info } from "lucide-react";
import { type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface KpiCardProps {
  title: string;
  value: ReactNode;
  change?: number;
  icon: LucideIcon;
  delay?: number;
  info?: string;
}

export function KpiCard({ title, value, change, icon: Icon, delay = 0, info }: KpiCardProps) {
  return (
    <div
      className="card-kpi tap-scale opacity-0 animate-fade-in"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        {change !== undefined && (
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs font-medium font-body px-2 py-0.5 rounded-full",
              change >= 0 ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"
            )}
          >
            {change >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {Math.abs(change)}%
          </span>
        )}
      </div>
      <div className="min-w-0 text-xl sm:text-2xl font-heading font-bold text-foreground leading-tight [overflow-wrap:anywhere]">
        {value}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5">
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
