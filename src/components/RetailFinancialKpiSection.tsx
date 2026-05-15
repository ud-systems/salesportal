import { Calculator, Info, PoundSterling, Receipt, RotateCcw, AlertTriangle } from "lucide-react";
import { type ScopeFinancialBreakdown, useShopifyOriginalTotalSyncHealth } from "@/hooks/use-shopify-data";
import { useAuth } from "@/contexts/AuthContext";
import { KpiCard } from "@/components/KpiCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatOrderMoney } from "@/lib/format";

const HERO_INFO = (
  <>
    <span className="font-medium text-foreground">Current gross sales</span> is the sum of{" "}
    <span className="font-medium">COALESCE(current_total, COALESCE(original_total, total))</span> (VAT inclusive), matching
    what customers owe after edits, per Shopify current totals.
    <span className="block mt-1">
    <span className="font-medium text-foreground">Original gross sales</span> uses{" "}
    <span className="font-medium">COALESCE(original_total, total)</span>: Shopify{" "}
    <span className="font-medium">originalTotalPriceSet</span> (clamped on sync to at least{" "}
    <span className="font-medium">totalPriceSet</span> and <span className="font-medium">currentTotalPriceSet</span> when the API returns a lower deposit/partial figure), else legacy{" "}
    <span className="font-medium">totalPriceSet</span>. <span className="font-medium">Voided</span> orders contribute £0
    to all money fields.
    </span>
  </>
);

export type RetailFinancialKpiSectionProps = {
  metrics: Partial<ScopeFinancialBreakdown> | null | undefined;
  loading: boolean;
  currency: string;
  /** Base delay (ms) for staggered card animation */
  delayBase?: number;
};

export function RetailFinancialKpiSection({ metrics, loading, currency, delayBase = 0 }: RetailFinancialKpiSectionProps) {
  const { user } = useAuth();
  const { data: syncHealth } = useShopifyOriginalTotalSyncHealth(Boolean(user?.id));
  const original = metrics?.original_gross_sales ?? 0;
  const current = metrics?.current_gross_sales ?? 0;
  const netExVat = metrics?.net_sales_ex_vat ?? 0;
  const vat = metrics?.vat_collected ?? 0;
  const refunded = metrics?.refunded_returned_value ?? 0;

  return (
    <div className="space-y-3">
      {syncHealth?.status === "migration_required" && (
        <Alert variant="destructive" className="text-left font-body text-sm">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="font-heading">Database not updated for refund-accurate KPIs</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>The live database is missing column <code className="text-xs">shopify_orders.original_total</code> (or the RPC patch). Until you apply it, returns/refunds will not match Shopify.</p>
            <p className="text-xs opacity-90">
              In Supabase → SQL Editor, run the migration file{" "}
              <code className="break-all">supabase/migrations/20260517120000_original_total_price_for_refund_kpis.sql</code>{" "}
              (and ensure <code className="break-all">20260516100000_retail_kpi_standard_definitions.sql</code> ran first). Automated{" "}
              <code className="text-xs">supabase db push</code> failed here because remote migration history does not match this repo.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {syncHealth?.status === "needs_resync" && (
        <Alert className="border-amber-500/40 bg-amber-500/5 text-amber-950 dark:text-amber-100 text-left font-body text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertTitle className="font-heading text-foreground">Shopify order totals need a refresh</AlertTitle>
          <AlertDescription>
            {syncHealth.missing.toLocaleString()} of {syncHealth.total.toLocaleString()} non-test orders still have no{" "}
            <code className="text-xs">original_total</code> (Shopify <span className="font-medium">originalTotalPriceSet</span>). Deploy
            updated <code className="text-xs">shopify-sync</code> and <code className="text-xs">shopify-webhook</code> edge functions, then run an orders sync or trigger{" "}
            <code className="text-xs">orders/updated</code> webhooks so rows backfill — then hard-refresh this page.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 lg:gap-4">
      <div
        className="col-span-2 card-kpi tap-scale opacity-0 animate-fade-in min-w-0"
        style={{ animationDelay: `${delayBase}ms` }}
      >
        <div className="flex items-start justify-between mb-2">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <PoundSterling className="h-5 w-5 text-primary" />
          </div>
        </div>
        <div className="mb-2 flex items-center gap-1.5 min-w-0">
          <p className="text-sm font-medium text-foreground font-body">Current gross sales</p>
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/80 hover:text-foreground"
                  aria-label="Explain current gross sales"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[280px] text-xs font-body leading-5">
                {HERO_INFO}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
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
                {formatOrderMoney(current, null, currency)}
              </p>
              <p className="text-sm text-muted-foreground font-body [overflow-wrap:anywhere]">
                Original gross {formatOrderMoney(original, null, currency)}
              </p>
            </>
          )}
        </div>
      </div>

      <KpiCard
        title="Net sales ex VAT"
        value={loading ? <Skeleton className="h-8 w-24 rounded-md" /> : formatOrderMoney(netExVat, null, currency)}
        icon={Calculator}
        delay={delayBase + 80}
        info="Sum of current gross minus tax per order (COALESCE(current_total, COALESCE(original_total, total)) − COALESCE(total_tax, 0)); voided orders £0."
      />
      <KpiCard
        title="VAT collected"
        value={loading ? <Skeleton className="h-8 w-20 rounded-md" /> : formatOrderMoney(vat, null, currency)}
        icon={Receipt}
        delay={delayBase + 120}
        info="Sum of total_tax from Shopify (currentTotalTaxSet); voided orders £0."
      />
      <KpiCard
        title="Refunded / returned"
        value={loading ? <Skeleton className="h-8 w-24 rounded-md" /> : formatOrderMoney(refunded, null, currency)}
        icon={RotateCcw}
        delay={delayBase + 160}
        info="Sum of GREATEST(COALESCE(original_total,total) − COALESCE(current_total, COALESCE(original_total,total)), 0) per order (VAT inclusive); voided orders £0."
      />
    </div>
    </div>
  );
}
