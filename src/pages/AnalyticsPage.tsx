import { useEffect, useMemo, useRef, useState } from "react";
import { XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Area, AreaChart, Bar, ComposedChart, Line } from "recharts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCard } from "@/components/KpiCard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShoppingCart, Users, FileDown, FileText, LayoutList, Info, ListChecks, ChartNoAxesCombined, RefreshCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useScopeOrderTimeseries,
  useScopeFinancialBreakdown,
  useScopeShopifySalesBreakdown,
  useAnalyticsOverviewKpis,
  useAnalyticsRfmGroupBreakdown,
  useAnalyticsRfmScoreMatrix,
  triggerOrderFinancialRefresh,
} from "@/hooks/use-shopify-data";
import { getDashboardRange, toRangeIso, formatPresetLabel, type DatePreset } from "@/lib/dashboard-date-range";
import { PeriodSelectItems } from "@/components/PeriodSelectItems";
import { differenceInCalendarDays } from "date-fns";
import { formatDisplayDate, formatOrderMoney } from "@/lib/format";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";
import {
  ANALYTICS_REPORTS,
  fetchReportData,
  rowsToCsv,
  type ReportDefinition,
} from "@/lib/analytics-report-data";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { toast } from "sonner";
import { RetailFinancialKpiSection } from "@/components/RetailFinancialKpiSection";
import { ShopifySalesBreakdownSection } from "@/components/ShopifySalesBreakdownSection";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useAdminOrderFinancialReconciliationCandidates } from "@/hooks/use-admin-order-reconciliation";

const PREVIEW_ROW_CAP = 200;
const RECON_CSV_COLUMNS = [
  "order_id",
  "shopify_order_id",
  "order_number",
  "shopify_created_at",
  "financial_status",
  "status_norm",
  "total",
  "original_total",
  "current_total",
  "subtotal",
  "total_tax",
  "eff_orig",
  "eff_curr",
  "eff_tax",
  "crm_refunded_returned_value",
  "missing_current_total",
  "flag_reasons",
] as const;
const MONEY_COLUMN_HINTS = /(revenue|total|subtotal|tax|price|amount|avg|average|aov|order value)/i;
const PDF_BRAND_PRIMARY_RGB: [number, number, number] = [93, 163, 67];
const PDF_BRAND_SECONDARY_RGB: [number, number, number] = [108, 191, 64];

let logoDataUrlPromise: Promise<string | null> | null = null;
let logoBadgeDataUrlPromise: Promise<string | null> | null = null;

function reportFileSlug(id: string) {
  return id.replace(/_/g, "-");
}

function getDisplayCurrencyLabel(currencyCode: string): string {
  const code = (currencyCode || "GBP").toUpperCase();
  if (code === "GBP") return "British Pounds (GBP)";
  return code;
}

function isMonetaryMetricLabel(metricLabel: string): boolean {
  return /(revenue|tax|subtotal|total|avg|average|aov|order value)/i.test(metricLabel);
}

function getReadableErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const message = [e.message, e.details, e.hint, e.code]
      .filter((v) => typeof v === "string" && v.trim().length > 0)
      .join(" | ");
    if (message) return message;
  }
  return fallback;
}

function formatReportCell(
  columnName: string,
  cell: string | number,
  currencyCode: string,
  row?: (string | number)[],
  columnIndex?: number,
): string {
  // Sales summary uses a generic "Value" column for mixed units (counts + currency).
  if (columnName.toLowerCase() === "value" && typeof columnIndex === "number" && columnIndex === 1 && row?.length) {
    const metricLabel = String(row[0] ?? "");
    if (!isMonetaryMetricLabel(metricLabel)) return String(cell);
  } else if (!MONEY_COLUMN_HINTS.test(columnName)) {
    return String(cell);
  }
  const n = typeof cell === "number" ? cell : Number(cell);
  if (!Number.isFinite(n)) return String(cell);
  return formatOrderMoney(n, null, currencyCode);
}

async function getBrandLogoDataUrl(): Promise<string | null> {
  if (!logoDataUrlPromise) {
    logoDataUrlPromise = (async () => {
      try {
        const response = await fetch("/white logo.png");
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0);
        return canvas.toDataURL("image/png");
      } catch {
        return null;
      }
    })();
  }
  return logoDataUrlPromise;
}

async function getBrandLogoBadgeDataUrl(): Promise<string | null> {
  if (!logoBadgeDataUrlPromise) {
    logoBadgeDataUrlPromise = (async () => {
      try {
        const size = 240;
        const radius = 36;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const gradient = ctx.createLinearGradient(0, 0, size, size);
        gradient.addColorStop(0, `rgb(${PDF_BRAND_PRIMARY_RGB.join(",")})`);
        gradient.addColorStop(1, `rgb(${PDF_BRAND_SECONDARY_RGB.join(",")})`);
        ctx.beginPath();
        ctx.moveTo(radius, 0);
        ctx.lineTo(size - radius, 0);
        ctx.quadraticCurveTo(size, 0, size, radius);
        ctx.lineTo(size, size - radius);
        ctx.quadraticCurveTo(size, size, size - radius, size);
        ctx.lineTo(radius, size);
        ctx.quadraticCurveTo(0, size, 0, size - radius);
        ctx.lineTo(0, radius);
        ctx.quadraticCurveTo(0, 0, radius, 0);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
        return canvas.toDataURL("image/png");
      } catch {
        return null;
      }
    })();
  }
  return logoBadgeDataUrlPromise;
}

export default function AnalyticsPage() {
  const { user, isAdmin } = useAuth();
  const { data: currency = "GBP" } = useShopDisplayCurrency();
  const [preset, setPreset] = useState<DatePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [selectedReportId, setSelectedReportId] = useState<string>(ANALYTICS_REPORTS[0].id);
  const [lowStockThreshold, setLowStockThreshold] = useState(10);
  const [preview, setPreview] = useState<{ columns: string[]; rows: (string | number)[][] } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);
  const [analyticsTab, setAnalyticsTab] = useState<"overview" | "reports">("overview");
  const [previewScrollProgress, setPreviewScrollProgress] = useState(0);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const [reconOnlyFlagged, setReconOnlyFlagged] = useState(true);
  const [reconResyncing, setReconResyncing] = useState(false);

  const range = useMemo(
    () => getDashboardRange(preset, customFrom || undefined, customTo || undefined),
    [preset, customFrom, customTo],
  );
  const fromIso = toRangeIso(range.from);
  const toIso = toRangeIso(range.to);
  const rangeDays =
    range.from && range.to ? Math.max(1, differenceInCalendarDays(range.to, range.from) + 1) : 365;
  const bucket = rangeDays <= 62 ? "day" : "month";

  const scopeKey = "analytics";
  const reconRangeBounded = Boolean(fromIso && toIso);
  const reconQueryEnabled = Boolean(user?.id && isAdmin && reconRangeBounded && analyticsTab === "overview");
  const {
    data: reconRows = [],
    isLoading: reconLoading,
    isError: reconIsError,
    error: reconQueryError,
    refetch: refetchRecon,
  } = useAdminOrderFinancialReconciliationCandidates(fromIso, toIso, reconOnlyFlagged, 500, reconQueryEnabled);

  const { data: metrics, isLoading: loadingMetrics } = useScopeFinancialBreakdown(
    user?.id,
    fromIso,
    toIso,
    Boolean(user?.id),
  );
  const { data: shopifySalesBreakdown, isLoading: loadingShopifySalesBreakdown } = useScopeShopifySalesBreakdown(
    user?.id,
    fromIso,
    toIso,
    Boolean(user?.id),
  );
  const { data: series = [], isLoading: loadingSeries } = useScopeOrderTimeseries(
    user?.id,
    fromIso,
    toIso,
    bucket,
    scopeKey,
    Boolean(user?.id),
  );
  const { data: overviewKpis, isLoading: loadingOverviewKpis } = useAnalyticsOverviewKpis(
    user?.id,
    fromIso,
    toIso,
    Boolean(user?.id),
  );
  const { data: rfmGroups = [], isLoading: loadingRfmGroups } = useAnalyticsRfmGroupBreakdown(
    user?.id,
    fromIso,
    toIso,
    Boolean(user?.id),
  );
  const { data: rfmMatrix = [], isLoading: loadingRfmMatrix } = useAnalyticsRfmScoreMatrix(
    user?.id,
    Boolean(user?.id),
  );

  const orders = metrics?.orders_total_count ?? 0;
  const activeBuyers = overviewKpis?.active_buyers_count ?? 0;
  const registrations = overviewKpis?.registrations_count ?? 0;
  const chartSeries = useMemo(() => series.map((point) => ({ ...point })), [series]);
  const rfmChartData = useMemo(
    () =>
      rfmGroups.map((row) => ({
        group: row.rfm_group,
        customers: row.customers_count,
        activeBuyers: row.active_buyers_count,
      })),
    [rfmGroups],
  );
  const rfmMatrixMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const cell of rfmMatrix) {
      map.set(`${cell.fm_score}-${cell.recency_score}`, Number(cell.customers_count || 0));
    }
    return map;
  }, [rfmMatrix]);
  const rfmMatrixMax = useMemo(
    () => Math.max(1, ...Array.from(rfmMatrixMap.values())),
    [rfmMatrixMap],
  );
  const chartRenderKey = useMemo(() => {
    const totals = chartSeries.reduce(
      (acc, point) => {
        acc.revenue += Number(point.revenue || 0);
        acc.orders += Number(point.orders || 0);
        return acc;
      },
      { revenue: 0, orders: 0 },
    );
    return `${fromIso ?? "none"}:${toIso ?? "none"}:${bucket}:${chartSeries.length}:${totals.revenue}:${totals.orders}`;
  }, [fromIso, toIso, bucket, chartSeries]);
  const compactCurrencyTick = useMemo(() => {
    const code = (currency || "GBP").toUpperCase();
    try {
      const formatter = new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: code,
        currencyDisplay: "symbol",
        notation: "compact",
        compactDisplay: "short",
        maximumFractionDigits: 1,
      });
      return (value: number) => formatter.format(Number(value || 0));
    } catch {
      return (value: number) => formatOrderMoney(value, null, currency);
    }
  }, [currency]);
  const chartTotals = useMemo(
    () =>
      chartSeries.reduce(
        (acc, point) => {
          acc.revenue += Number(point.revenue || 0);
          acc.orders += Number(point.orders || 0);
          return acc;
        },
        { revenue: 0, orders: 0 },
      ),
    [chartSeries],
  );

  const selectedDef = ANALYTICS_REPORTS.find((r) => r.id === selectedReportId) as ReportDefinition | undefined;
  const rangeReady = Boolean(fromIso && toIso);
  const canLoadReport = selectedDef && (!selectedDef.requiresRange || rangeReady);

  useEffect(() => {
    if (!selectedDef || !canLoadReport) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    fetchReportData(selectedReportId, {
      fromIso,
      toIso,
      currency,
      viewerUserId: user?.id,
      lowStockThreshold,
      maxRows: PREVIEW_ROW_CAP,
    })
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((e) => {
        if (!cancelled) {
          setPreview(null);
          toast.error(getReadableErrorMessage(e, "Could not load report"));
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedReportId, selectedDef, canLoadReport, fromIso, toIso, currency, user?.id, lowStockThreshold]);

  const previewRows = preview?.rows ?? [];
  const previewSlice = previewRows.slice(0, PREVIEW_ROW_CAP);
  const previewTruncated = previewRows.length > PREVIEW_ROW_CAP;

  const updatePreviewScrollProgress = () => {
    const el = previewScrollRef.current;
    if (!el) return;
    const maxScroll = el.scrollHeight - el.clientHeight;
    if (maxScroll <= 0) {
      setPreviewScrollProgress(0);
      return;
    }
    const progress = Math.min(100, Math.max(0, (el.scrollTop / maxScroll) * 100));
    setPreviewScrollProgress(progress);
  };

  useEffect(() => {
    const id = window.requestAnimationFrame(() => updatePreviewScrollProgress());
    return () => window.cancelAnimationFrame(id);
  }, [previewLoading, previewRows.length, selectedReportId, analyticsTab]);

  const periodSubtitle = selectedDef?.requiresRange
    ? `Period: ${formatPresetLabel(preset)}${
        rangeReady ? ` | ${formatDisplayDate(fromIso)} - ${formatDisplayDate(toIso)}` : ""
      }`
    : "Snapshot report (not filtered by period)";

  const runExportCsv = async () => {
    if (!selectedDef || !canLoadReport) {
      toast.error(selectedDef?.requiresRange ? "Select a date range first." : "Report unavailable.");
      return;
    }
    setExporting("csv");
    try {
      const { columns, rows } = await fetchReportData(selectedReportId, {
        fromIso,
        toIso,
        currency,
        viewerUserId: user?.id,
        lowStockThreshold,
      });
      const csv = rowsToCsv(columns, rows);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${reportFileSlug(selectedReportId)}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("CSV downloaded");
    } catch (e) {
      toast.error(getReadableErrorMessage(e, "Export failed"));
    } finally {
      setExporting(null);
    }
  };

  const runExportPdf = async () => {
    if (!selectedDef || !canLoadReport) {
      toast.error(selectedDef?.requiresRange ? "Select a date range first." : "Report unavailable.");
      return;
    }
    setExporting("pdf");
    try {
      const { columns, rows } = await fetchReportData(selectedReportId, {
        fromIso,
        toIso,
        currency,
        viewerUserId: user?.id,
        lowStockThreshold,
      });
      const wide = columns.length > 6;
      const doc = new jsPDF({ unit: "mm", format: "a4", orientation: wide ? "landscape" : "portrait" });
      const logoDataUrl = await getBrandLogoDataUrl();
      const logoBadgeDataUrl = await getBrandLogoBadgeDataUrl();
      const headerX = 14;
      const logoY = 10;
      const logoBoxSize = 24;
      if (logoBadgeDataUrl) {
        doc.addImage(logoBadgeDataUrl, "PNG", headerX, logoY, logoBoxSize, logoBoxSize);
      } else {
        doc.setFillColor(...PDF_BRAND_PRIMARY_RGB);
        doc.roundedRect(headerX, logoY, logoBoxSize, logoBoxSize, 4, 4, "F");
      }
      if (logoDataUrl) {
        const imgProps = doc.getImageProperties(logoDataUrl);
        const imgRatio = imgProps.width / imgProps.height;
        const maxImgSide = logoBoxSize - 6;
        let imgW = maxImgSide;
        let imgH = maxImgSide;
        if (imgRatio > 1) {
          imgH = imgW / imgRatio;
        } else if (imgRatio < 1) {
          imgW = imgH * imgRatio;
        }
        const imgX = headerX + (logoBoxSize - imgW) / 2;
        const imgY = logoY + (logoBoxSize - imgH) / 2;
        doc.addImage(logoDataUrl, "PNG", imgX, imgY, imgW, imgH);
      }
      doc.setFontSize(15);
      doc.text("Sales Portal — " + selectedDef.title, headerX, 41);
      doc.setFontSize(9);
      doc.setTextColor(90);
      doc.text(periodSubtitle, headerX, 47);
      doc.text(
        `Generated ${new Date().toLocaleString("en-GB")} · Display currency: ${getDisplayCurrencyLabel(currency)}`,
        headerX,
        52,
      );
      doc.setTextColor(0);

      const body = rows.map((r) => r.map((c, index) => formatReportCell(columns[index], c, currency, r, index)));
      autoTable(doc, {
        startY: 58,
        head: [columns],
        body,
        styles: { fontSize: wide ? 6 : 7, cellPadding: 1.5 },
        headStyles: { fillColor: PDF_BRAND_PRIMARY_RGB },
        horizontalPageBreak: true,
        margin: { left: 14, right: 14 },
      });

      doc.save(`${reportFileSlug(selectedReportId)}-${new Date().toISOString().slice(0, 10)}.pdf`);
      toast.success("PDF downloaded");
    } catch (e) {
      toast.error(getReadableErrorMessage(e, "PDF export failed"));
    } finally {
      setExporting(null);
    }
  };

  const exportReconciliationCsv = () => {
    if (!reconRows.length) {
      toast.error("No rows to export for this filter.");
      return;
    }
    const cols = [...RECON_CSV_COLUMNS];
    const rows = reconRows.map((r) =>
      cols.map((key) => {
        const v = r[key as keyof (typeof reconRows)[number]];
        if (v === null || v === undefined) return "";
        if (typeof v === "boolean") return v ? "true" : "false";
        return v as string | number;
      }),
    );
    const csv = rowsToCsv(cols, rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const slug = `order-financial-reconciliation-${reconOnlyFlagged ? "flagged" : "all"}-${new Date().toISOString().slice(0, 10)}`;
    a.download = `${slug}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success("Reconciliation CSV downloaded");
  };

  const handleReconResyncListedFromShopify = async () => {
    if (!reconRows.length) return;
    setReconResyncing(true);
    try {
      const ids = reconRows.map((r) => r.shopify_order_id).filter(Boolean);
      const data = (await triggerOrderFinancialRefresh({ shopify_order_ids: ids })) as {
        refreshed?: number;
        failed?: number;
      };
      toast.success(
        `Shopify re-fetch finished: ${Number(data?.refreshed ?? 0)} updated, ${Number(data?.failed ?? 0)} failed (max 40 per run).`,
      );
      await refetchRecon();
    } catch (e) {
      toast.error(getReadableErrorMessage(e, "Re-fetch from Shopify failed"));
    } finally {
      setReconResyncing(false);
    }
  };

  const handleReconResyncStaleRefundedGlobal = async () => {
    setReconResyncing(true);
    try {
      const data = (await triggerOrderFinancialRefresh({ auto_stale_refunded_totals_match: true })) as {
        refreshed?: number;
        failed?: number;
      };
      toast.success(
        `Stale refunded-like orders: ${Number(data?.refreshed ?? 0)} updated, ${Number(data?.failed ?? 0)} failed.`,
      );
      await refetchRecon();
    } catch (e) {
      toast.error(getReadableErrorMessage(e, "Stale-order refresh failed"));
    } finally {
      setReconResyncing(false);
    }
  };

  useEffect(() => {
    if (!reconIsError || !reconQueryError) return;
    toast.error(getReadableErrorMessage(reconQueryError, "Could not load order reconciliation."));
  }, [reconIsError, reconQueryError]);

  return (
    <div className="w-full space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 opacity-0 animate-fade-in">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Analytics</h1>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Analytics page information"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:text-foreground sm:hidden"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[260px] text-xs leading-relaxed">
                  KPIs, charts, and report previews from live Shopify data - export any report as CSV or PDF.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <p className="hidden sm:block text-muted-foreground font-body text-sm mt-1">
            KPIs, charts, and report previews from live Shopify data — export any report as CSV or PDF
          </p>
        </div>
      </div>

      <div className="card-float p-4 flex flex-col sm:flex-row flex-wrap gap-3 items-stretch sm:items-end">
        <div className="flex-1 min-w-[160px]">
          <p className="text-xs font-medium text-muted-foreground font-body mb-1.5">Period</p>
          <Select value={preset} onValueChange={(v) => setPreset(v as DatePreset)}>
            <SelectTrigger className="rounded-xl h-10 font-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <PeriodSelectItems />
            </SelectContent>
          </Select>
        </div>
        {preset === "custom" && (
          <div className="flex flex-col sm:flex-row gap-2 flex-1">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-10 rounded-xl border bg-card px-3 text-sm font-body flex-1"
            />
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-10 rounded-xl border bg-card px-3 text-sm font-body flex-1"
            />
          </div>
        )}
      </div>

      <Tabs value={analyticsTab} onValueChange={(value) => setAnalyticsTab(value as "overview" | "reports")}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="overview" className="flex-1 sm:flex-none">
            Overview
          </TabsTrigger>
          <TabsTrigger value="reports" className="flex-1 sm:flex-none">
            Reports
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="space-y-3">
            <ShopifySalesBreakdownSection
              breakdown={shopifySalesBreakdown}
              loading={loadingShopifySalesBreakdown}
              currency={currency}
              delayBase={50}
            />
            <RetailFinancialKpiSection
              metrics={metrics}
              loading={loadingMetrics}
              currency={currency}
              delayBase={100}
              collapsible
              defaultOpen={false}
            />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <KpiCard
                title="Total orders"
                value={loadingMetrics ? <Skeleton className="h-8 w-16 rounded-md" /> : String(orders)}
                icon={ShoppingCart}
                delay={200}
              />
              <KpiCard
                title="Active buyers"
                value={loadingOverviewKpis ? <Skeleton className="h-8 w-16 rounded-md" /> : String(activeBuyers)}
                icon={Users}
                delay={250}
              />
              <KpiCard
                title="Registrations"
                value={loadingOverviewKpis ? <Skeleton className="h-8 w-16 rounded-md" /> : String(registrations)}
                icon={Users}
                delay={300}
              />
            </div>
          </div>

          {isAdmin && reconRangeBounded && (
            <div className="card-float p-4 sm:p-5 space-y-4 opacity-0 animate-fade-in">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <ListChecks className="h-5 w-5 text-primary shrink-0" />
                    <h3 className="font-heading font-semibold text-foreground">Order financial reconciliation</h3>
                  </div>
                  <p className="text-xs sm:text-sm text-muted-foreground font-body max-w-3xl leading-relaxed">
                    Live CRM row values for the selected period (filter: <span className="font-medium">shopify_created_at</span>, same window as KPI charts).{" "}
                    <span className="font-medium">crm_refunded_returned_value</span> matches the retail KPI refund slice. Flagged rows are heuristics for sync gaps — export and compare line-by-line to Shopify for those order IDs.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row lg:flex-col gap-3 shrink-0 lg:items-end">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="recon-only-flagged"
                      checked={reconOnlyFlagged}
                      onCheckedChange={(v) => setReconOnlyFlagged(Boolean(v))}
                    />
                    <Label htmlFor="recon-only-flagged" className="text-sm font-body cursor-pointer whitespace-nowrap">
                      Only flagged
                    </Label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void refetchRecon()}
                      disabled={reconLoading || reconResyncing}
                      className="font-body"
                    >
                      Refresh
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleReconResyncListedFromShopify()}
                      disabled={!reconRows.length || reconLoading || reconResyncing}
                      className="font-body"
                      title="Re-fetch up to 40 listed orders from Shopify Admin (same payload as webhooks)."
                    >
                      <RefreshCw className={`h-4 w-4 mr-1.5 ${reconResyncing ? "animate-spin" : ""}`} />
                      Re-sync listed
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleReconResyncStaleRefundedGlobal()}
                      disabled={reconLoading || reconResyncing}
                      className="font-body"
                      title="Orders with refunded-like status but current_total still equals total (Shopify timing); max 40."
                    >
                      Stale refunded scan
                    </Button>
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={exportReconciliationCsv}
                      disabled={!reconRows.length || reconLoading}
                      className="font-body"
                    >
                      <FileDown className="h-4 w-4 mr-1.5" />
                      Export CSV
                    </Button>
                  </div>
                </div>
              </div>
              {reconIsError ? (
                <p className="text-sm text-destructive font-body">
                  Reconciliation query failed. If the RPC is missing, apply{" "}
                  <code className="text-xs break-all">supabase/migrations/20260518140000_admin_order_financial_reconciliation_rpc.sql</code> in Supabase SQL Editor.
                </p>
              ) : reconLoading ? (
                <Skeleton className="h-40 w-full rounded-xl" />
              ) : reconRows.length === 0 ? (
                <p className="text-sm text-muted-foreground font-body">
                  {reconOnlyFlagged
                    ? "No orders matched the flag rules for this period — try turning off \"Only flagged\" to list every order in range (capped at 500), or pick a day where Shopify and CRM still disagree."
                    : "No orders in this period."}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border max-h-[min(420px,70vh)] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="whitespace-nowrap text-xs">Order #</TableHead>
                        <TableHead className="whitespace-nowrap text-xs">Shopify order ID</TableHead>
                        <TableHead className="whitespace-nowrap text-xs">Created</TableHead>
                        <TableHead className="whitespace-nowrap text-xs">Financial status</TableHead>
                        <TableHead className="text-right whitespace-nowrap text-xs">total</TableHead>
                        <TableHead className="text-right whitespace-nowrap text-xs">original_total</TableHead>
                        <TableHead className="text-right whitespace-nowrap text-xs">current_total</TableHead>
                        <TableHead className="text-right whitespace-nowrap text-xs">subtotal</TableHead>
                        <TableHead className="text-right whitespace-nowrap text-xs">total_tax</TableHead>
                        <TableHead className="text-right whitespace-nowrap text-xs">CRM refund slice</TableHead>
                        <TableHead className="text-xs min-w-[200px]">Flags</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reconRows.map((row) => (
                        <TableRow key={row.order_id}>
                          <TableCell className="font-mono text-xs whitespace-nowrap">{row.order_number ?? "—"}</TableCell>
                          <TableCell className="font-mono text-xs max-w-[140px] truncate" title={row.shopify_order_id}>
                            {row.shopify_order_id}
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">
                            {row.shopify_created_at ? formatDisplayDate(row.shopify_created_at) : "—"}
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{row.financial_status ?? "—"}</TableCell>
                          <TableCell className="text-xs text-right whitespace-nowrap">
                            {formatOrderMoney(Number(row.total ?? 0), null, currency)}
                          </TableCell>
                          <TableCell className="text-xs text-right whitespace-nowrap">
                            {formatOrderMoney(Number(row.original_total ?? 0), null, currency)}
                          </TableCell>
                          <TableCell className="text-xs text-right whitespace-nowrap">
                            {row.current_total == null ? "—" : formatOrderMoney(Number(row.current_total), null, currency)}
                          </TableCell>
                          <TableCell className="text-xs text-right whitespace-nowrap">
                            {formatOrderMoney(Number(row.subtotal ?? 0), null, currency)}
                          </TableCell>
                          <TableCell className="text-xs text-right whitespace-nowrap">
                            {formatOrderMoney(Number(row.total_tax ?? 0), null, currency)}
                          </TableCell>
                          <TableCell className="text-xs text-right whitespace-nowrap">
                            {formatOrderMoney(Number(row.crm_refunded_returned_value ?? 0), null, currency)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground leading-snug">{row.flag_reasons || "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}

          {isAdmin && !reconRangeBounded && (
            <div className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground font-body">
              Choose a bounded period (not &quot;All time&quot;) to run per-order financial reconciliation against Shopify.
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card-float p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2 mb-3 sm:mb-4">
                <h3 className="font-heading font-semibold text-foreground">Current gross sales trend</h3>
                <span className="text-xs text-muted-foreground font-body">
                  Total {formatOrderMoney(chartTotals.revenue, null, currency)}
                </span>
              </div>
              {loadingSeries ? (
                <Skeleton className="h-[220px] sm:h-[240px] w-full rounded-xl" />
              ) : chartSeries.length === 0 ? (
                <div className="h-[220px] sm:h-[240px] min-h-[220px] min-w-0 w-full rounded-xl border border-dashed flex flex-col items-center justify-center gap-2 bg-muted/20">
                  <ChartNoAxesCombined className="h-5 w-5 text-muted-foreground" />
                  <p className="text-muted-foreground text-sm font-body text-center">No orders in this period.</p>
                </div>
              ) : (
                <div className="h-[220px] sm:h-[240px] min-h-[220px] min-w-0 w-full rounded-xl border bg-muted/10 p-2 sm:p-3">
                  <ResponsiveContainer key={`revenue-${chartRenderKey}`} width="100%" height={220} minWidth={0} minHeight={220}>
                    <ComposedChart data={chartSeries} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="analyticsRevenueBarGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.95} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.55} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      interval={chartSeries.length > 10 ? "preserveStartEnd" : 0}
                      minTickGap={20}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis
                      width={44}
                      tickFormatter={(v) => compactCurrencyTick(Number(v))}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis
                      yAxisId="orders"
                      orientation="right"
                      width={0}
                      hide
                      domain={[0, "auto"]}
                    />
                    <RechartsTooltip
                      formatter={(v: number, _name, item) => {
                        if (item?.dataKey === "orders") return [Number(v || 0).toLocaleString(), "Orders"];
                        return [formatOrderMoney(v, null, currency), "Current gross sales"];
                      }}
                      labelFormatter={(label) => `Period: ${label}`}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid hsl(var(--border))",
                        background: "hsl(var(--card))",
                        boxShadow: "0 10px 30px hsl(var(--foreground) / 0.08)",
                      }}
                      cursor={{ fill: "hsl(var(--primary) / 0.08)" }}
                    />
                    <Bar dataKey="revenue" fill="url(#analyticsRevenueBarGradient)" radius={[6, 6, 0, 0]} maxBarSize={30} />
                    <Line
                      yAxisId="orders"
                      type="monotone"
                      dataKey="orders"
                      stroke="hsl(var(--primary) / 0.7)"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0 }}
                    />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="card-float p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2 mb-3 sm:mb-4">
                <h3 className="font-heading font-semibold text-foreground">Order volume</h3>
                <span className="text-xs text-muted-foreground font-body">Total {chartTotals.orders.toLocaleString()}</span>
              </div>
              {loadingSeries ? (
                <Skeleton className="h-[220px] sm:h-[240px] w-full rounded-xl" />
              ) : chartSeries.length === 0 ? (
                <div className="h-[220px] sm:h-[240px] min-h-[220px] min-w-0 w-full rounded-xl border border-dashed flex flex-col items-center justify-center gap-2 bg-muted/20">
                  <ChartNoAxesCombined className="h-5 w-5 text-muted-foreground" />
                  <p className="text-muted-foreground text-sm font-body text-center">No order volume data.</p>
                </div>
              ) : (
                <div className="h-[220px] sm:h-[240px] min-h-[220px] min-w-0 w-full rounded-xl border bg-muted/10 p-2 sm:p-3">
                  <ResponsiveContainer key={`orders-${chartRenderKey}`} width="100%" height={220} minWidth={0} minHeight={220}>
                    <AreaChart data={chartSeries} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="analyticsOrdersGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.36} />
                        <stop offset="65%" stopColor="hsl(var(--primary))" stopOpacity={0.14} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.03} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      interval={chartSeries.length > 10 ? "preserveStartEnd" : 0}
                      minTickGap={20}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis width={44} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <RechartsTooltip
                      formatter={(v: number) => [Number(v || 0).toLocaleString(), "Orders"]}
                      labelFormatter={(label) => `Period: ${label}`}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid hsl(var(--border))",
                        background: "hsl(var(--card))",
                        boxShadow: "0 10px 30px hsl(var(--foreground) / 0.08)",
                      }}
                      cursor={{ fill: "hsl(var(--primary) / 0.08)" }}
                    />
                    <Area
                      type="monotone"
                      dataKey="orders"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2.5}
                      fill="url(#analyticsOrdersGradient)"
                      fillOpacity={1}
                      activeDot={{ r: 4 }}
                    />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="card-float p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2 mb-3 sm:mb-4">
                <h3 className="font-heading font-semibold text-foreground">RFM group distribution</h3>
                <span className="text-xs text-muted-foreground font-body">
                  Total {rfmChartData.reduce((sum, row) => sum + Number(row.customers || 0), 0).toLocaleString()} customers
                </span>
              </div>
              {loadingRfmGroups ? (
                <Skeleton className="h-[220px] sm:h-[240px] w-full rounded-xl" />
              ) : rfmChartData.length === 0 ? (
                <div className="h-[220px] sm:h-[240px] min-h-[220px] min-w-0 w-full rounded-xl border border-dashed flex flex-col items-center justify-center gap-2 bg-muted/20">
                  <ChartNoAxesCombined className="h-5 w-5 text-muted-foreground" />
                  <p className="text-muted-foreground text-sm font-body text-center">No RFM data available yet.</p>
                </div>
              ) : (
                <div className="h-[220px] sm:h-[240px] min-h-[220px] min-w-0 w-full rounded-xl border bg-muted/10 p-2 sm:p-3">
                  <ResponsiveContainer width="100%" height={220} minWidth={0} minHeight={220}>
                    <ComposedChart data={rfmChartData} margin={{ top: 8, right: 4, left: 0, bottom: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey="group"
                        interval={0}
                        angle={-20}
                        textAnchor="end"
                        height={56}
                        minTickGap={24}
                        tick={{ fontSize: 10 }}
                        stroke="hsl(var(--muted-foreground))"
                      />
                      <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                      <RechartsTooltip
                        formatter={(value: number, name) => [Number(value || 0).toLocaleString(), name === "activeBuyers" ? "Active buyers" : "Customers"]}
                        contentStyle={{
                          borderRadius: 12,
                          border: "1px solid hsl(var(--border))",
                          background: "hsl(var(--card))",
                          boxShadow: "0 10px 30px hsl(var(--foreground) / 0.08)",
                        }}
                        cursor={{ fill: "hsl(var(--primary) / 0.08)" }}
                      />
                      <Bar dataKey="customers" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} maxBarSize={34} />
                      <Line
                        type="monotone"
                        dataKey="activeBuyers"
                        stroke="hsl(var(--primary) / 0.65)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, strokeWidth: 0 }}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="card-float p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2 mb-3 sm:mb-4">
                <h3 className="font-heading font-semibold text-foreground">RFM customer analysis</h3>
                <span className="text-xs text-muted-foreground font-body">Shopify-style score matrix</span>
              </div>
              {loadingRfmMatrix ? (
                <Skeleton className="h-[220px] sm:h-[240px] w-full rounded-xl" />
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-[42px_repeat(5,minmax(0,1fr))] gap-1">
                    <div />
                    {[1, 2, 3, 4, 5].map((r) => (
                      <div key={`x-${r}`} className="text-[11px] text-muted-foreground text-center">{r}</div>
                    ))}
                    {[5, 4, 3, 2, 1].map((fm) => (
                      <div key={`row-${fm}`} className="contents">
                        <div className="text-[11px] text-muted-foreground flex items-center justify-center">{fm}</div>
                        {[1, 2, 3, 4, 5].map((r) => {
                          const value = rfmMatrixMap.get(`${fm}-${r}`) || 0;
                          const intensity = value <= 0 ? 0.06 : Math.max(0.12, value / rfmMatrixMax);
                          return (
                            <div
                              key={`c-${fm}-${r}`}
                              className="rounded-md h-10 flex items-center justify-center text-xs font-semibold text-foreground border border-border/40"
                              style={{ backgroundColor: `hsl(var(--primary) / ${intensity})` }}
                              title={`Recency ${r}, FM ${fm}: ${value.toLocaleString()} customers`}
                            >
                              {value > 0 ? value.toLocaleString() : ""}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>Frequency + Monetary value score</span>
                    <span>Recency score</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="reports">
          <div className="card-float p-4 sm:p-5 space-y-4">
            <div className="flex items-start gap-2">
              <LayoutList className="h-5 w-5 text-primary mt-0.5 shrink-0" />
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-heading font-semibold text-foreground">Report library</h3>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label="Report library information"
                          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:text-foreground sm:hidden"
                        >
                          <Info className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[260px] text-xs leading-relaxed">
                        Choose a report to preview live data. CSV and PDF include every row returned from the database for
                        that report (not only the preview cap).
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p className="hidden sm:block text-sm text-muted-foreground font-body mt-1 max-w-xl">
                  Choose a report to preview live data. CSV and PDF include every row returned from the database for that
                  report (not only the preview cap).
                </p>
              </div>
            </div>

            <div className="flex flex-col xl:flex-row gap-4">
              <div className="xl:w-[300px] flex flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground font-body">Report</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-1.5 xl:max-h-[min(60vh,420px)] xl:overflow-y-auto xl:pr-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                  {ANALYTICS_REPORTS.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedReportId(r.id)}
                      className={cn(
                        "text-left rounded-xl border px-3 py-2.5 text-sm font-body transition-colors",
                        selectedReportId === r.id
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-card hover:bg-muted/50 text-foreground",
                      )}
                    >
                      <span className="font-medium block">{r.title}</span>
                      <span className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{r.description}</span>
                      {r.requiresRange && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1 block">Uses period</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 min-w-0 space-y-3">
                {selectedReportId === "low_stock" && (
                  <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                    <div className="w-full sm:w-[220px]">
                      <p className="text-xs font-medium text-muted-foreground font-body mb-1">Max stock (inclusive)</p>
                      <input
                        type="number"
                        min={0}
                        value={lowStockThreshold}
                        onChange={(e) => setLowStockThreshold(Math.max(0, Number(e.target.value) || 0))}
                        className="h-10 w-full rounded-xl border bg-card px-3 text-sm font-body"
                      />
                    </div>
                  </div>
                )}

                {selectedDef?.requiresRange && !rangeReady && (
                  <p className="text-sm text-amber-600 dark:text-amber-500 font-body">
                    Pick a valid period (including custom dates) to load this report.
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="rounded-xl gap-2"
                    disabled={!canLoadReport || exporting !== null || previewLoading}
                    onClick={() => void runExportCsv()}
                  >
                    <FileDown className="h-4 w-4" />
                    Download CSV
                  </Button>
                  <Button
                    className="rounded-xl gap-2"
                    disabled={!canLoadReport || exporting !== null || previewLoading}
                    onClick={() => void runExportPdf()}
                  >
                    <FileText className="h-4 w-4" />
                    Download PDF
                  </Button>
                </div>

                <div className="rounded-xl border bg-card overflow-hidden">
                  <div className="px-4 py-3 border-b bg-muted/30 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <p className="font-heading font-semibold text-sm text-foreground">Preview</p>
                      <p className="text-xs text-muted-foreground font-body">{selectedDef?.title}</p>
                    </div>
                    {!previewLoading && preview && (
                      <p className="text-xs text-muted-foreground font-body">
                        {previewTruncated
                          ? `Showing first ${PREVIEW_ROW_CAP} of ${previewRows.length} rows`
                          : `${previewRows.length} row${previewRows.length === 1 ? "" : "s"}`}
                      </p>
                    )}
                  </div>
                  <div className="h-1 bg-muted">
                    <div
                      className="h-full bg-primary transition-[width] duration-150"
                      style={{ width: `${previewScrollProgress}%` }}
                    />
                  </div>
                  <div
                    ref={previewScrollRef}
                    onScroll={updatePreviewScrollProgress}
                    className="max-h-[min(55vh,460px)] overflow-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                  >
                    {previewLoading ? (
                      <div className="p-8 space-y-2">
                        <Skeleton className="h-8 w-full rounded-md" />
                        <Skeleton className="h-8 w-full rounded-md" />
                        <Skeleton className="h-8 w-3/4 rounded-md" />
                      </div>
                    ) : !preview || previewSlice.length === 0 ? (
                      <p className="text-muted-foreground text-sm font-body p-8 text-center">No rows to show.</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {preview.columns.map((c) => (
                              <TableHead key={c} className="whitespace-nowrap font-body text-xs">
                                {c}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {previewSlice.map((row, i) => (
                            <TableRow key={i}>
                              {row.map((cell, j) => (
                                <TableCell
                                  key={j}
                                  className="font-body text-xs max-w-[200px] truncate"
                                  title={formatReportCell(preview.columns[j], cell, currency, row, j)}
                                >
                                  {formatReportCell(preview.columns[j], cell, currency, row, j)}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
