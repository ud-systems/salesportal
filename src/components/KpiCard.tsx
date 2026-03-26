import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";
import { type LucideIcon } from "lucide-react";

interface KpiCardProps {
  title: string;
  value: string;
  change?: number;
  icon: LucideIcon;
  delay?: number;
}

export function KpiCard({ title, value, change, icon: Icon, delay = 0 }: KpiCardProps) {
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
      <p className="text-2xl font-heading font-bold text-foreground">{value}</p>
      <p className="text-sm text-muted-foreground font-body mt-0.5">{title}</p>
    </div>
  );
}
