import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, LineChart, Line } from "recharts";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCard } from "@/components/KpiCard";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DollarSign, ShoppingCart, Users, TrendingUp, FileDown, FileText, LayoutList, Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useCustomersCountInRange,
  useOrdersMetricsInRange,
  useOrdersTimeseriesInRange,
} from "@/hooks/use-shopify-data";
import { getDashboardRange, toRangeIso, type DatePreset } from "@/lib/dashboard-date-range";
import { differenceInCalendarDays } from "date-fns";
import { formatOrderMoney } from "@/lib/format";
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
import { cn } from "@/lib/utils";

const PREVIEW_ROW_CAP = 200;

function reportFileSlug(id: string) {
  return id.replace(/_/g, "-");
}

export default function AnalyticsPage() {
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

  const range = useMemo(
    () => getDashboardRange(preset, customFrom || undefined, customTo || undefined),
    [preset, customFrom, customTo],
  );
  const fromIso = toRangeIso(range.from);
  const toIso = toRangeIso(range.to);
  const rangeDays =
    range.from && range.to ? Math.max(1, differenceInCalendarDays(range.to, range.from) + 1) : 30;
  const bucket = rangeDays <= 62 ? "day" : "month";

  const scopeKey = "analytics";
  const { data: metrics, isLoading: loadingMetrics } = useOrdersMetricsInRange(fromIso, toIso, scopeKey, Boolean(fromIso && toIso));
  const { data: custCount = 0, isLoading: loadingCust } = useCustomersCountInRange(fromIso, toIso, scopeKey, Boolean(fromIso && toIso));
  const { data: series = [], isLoading: loadingSeries } = useOrdersTimeseriesInRange(
    fromIso,
    toIso,
    bucket,
    scopeKey,
    Boolean(fromIso && toIso),
  );

  const revenue = metrics?.revenue ?? 0;
  const orders = metrics?.count ?? 0;
  const aov = orders > 0 ? Math.round(revenue / orders) : 0;
  const chartSeries = useMemo(() => series.map((point) => ({ ...point })), [series]);
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
      lowStockThreshold,
    })
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((e) => {
        if (!cancelled) {
          setPreview(null);
          toast.error(e instanceof Error ? e.message : "Could not load report");
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedReportId, selectedDef, canLoadReport, fromIso, toIso, currency, lowStockThreshold]);

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
    ? `Period: ${preset}${rangeReady ? ` (${fromIso?.slice(0, 10)} → ${toIso?.slice(0, 10)})` : ""}`
    : "Snapshot (not filtered by analytics period)";

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
      toast.error(e instanceof Error ? e.message : "Export failed");
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
        lowStockThreshold,
      });
      const wide = columns.length > 6;
      const doc = new jsPDF({ unit: "mm", format: "a4", orientation: wide ? "landscape" : "portrait" });
      doc.setFontSize(15);
      doc.text("UD Sales — " + selectedDef.title, 14, 16);
      doc.setFontSize(9);
      doc.setTextColor(90);
      doc.text(periodSubtitle, 14, 22);
      doc.text(`Generated ${new Date().toLocaleString("en-GB")} · Display currency: ${currency}`, 14, 27);
      doc.setTextColor(0);

      const body = rows.map((r) => r.map((c) => String(c)));
      autoTable(doc, {
        startY: 32,
        head: [columns],
        body,
        styles: { fontSize: wide ? 6 : 7, cellPadding: 1.5 },
        headStyles: { fillColor: [41, 98, 255] },
        horizontalPageBreak: true,
        margin: { left: 14, right: 14 },
      });

      doc.save(`${reportFileSlug(selectedReportId)}-${new Date().toISOString().slice(0, 10)}.pdf`);
      toast.success("PDF downloaded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "PDF export failed");
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="space-y-6 max-w-[1200px]">
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
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="week">Last 7 days</SelectItem>
              <SelectItem value="month">This month</SelectItem>
              <SelectItem value="quarter">This quarter</SelectItem>
              <SelectItem value="year">This year</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
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
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard
              title="Revenue"
              value={loadingMetrics ? <Skeleton className="h-8 w-28 rounded-md" /> : formatOrderMoney(revenue, null, currency)}
              icon={DollarSign}
              delay={50}
            />
            <KpiCard
              title="Orders"
              value={loadingMetrics ? <Skeleton className="h-8 w-16 rounded-md" /> : String(orders)}
              icon={ShoppingCart}
              delay={100}
            />
            <KpiCard
              title="New customers"
              value={loadingCust ? <Skeleton className="h-8 w-16 rounded-md" /> : String(custCount)}
              icon={Users}
              delay={150}
            />
            <KpiCard
              title="Avg. order"
              value={loadingMetrics ? <Skeleton className="h-8 w-24 rounded-md" /> : formatOrderMoney(aov, null, currency)}
              icon={TrendingUp}
              delay={200}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card-float p-4 sm:p-5">
              <h3 className="font-heading font-semibold text-foreground mb-3 sm:mb-4">Revenue trend</h3>
              {loadingSeries ? (
                <Skeleton className="h-[220px] sm:h-[240px] w-full rounded-xl" />
              ) : chartSeries.length === 0 ? (
                <p className="text-muted-foreground text-sm font-body py-12 text-center">No orders in this range.</p>
              ) : (
                <div className="h-[220px] sm:h-[240px] w-full">
                  <ResponsiveContainer key={`revenue-${chartRenderKey}`} width="100%" height="100%">
                    <BarChart data={chartSeries} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      interval="preserveStartEnd"
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
                    <RechartsTooltip
                      formatter={(v: number) => formatOrderMoney(v, null, currency)}
                      contentStyle={{ borderRadius: 12, border: "1px solid hsl(var(--border))" }}
                    />
                    <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="card-float p-4 sm:p-5">
              <h3 className="font-heading font-semibold text-foreground mb-3 sm:mb-4">Order volume</h3>
              {loadingSeries ? (
                <Skeleton className="h-[220px] sm:h-[240px] w-full rounded-xl" />
              ) : chartSeries.length === 0 ? (
                <p className="text-muted-foreground text-sm font-body py-12 text-center">No data.</p>
              ) : (
                <div className="h-[220px] sm:h-[240px] w-full">
                  <ResponsiveContainer key={`orders-${chartRenderKey}`} width="100%" height="100%">
                    <LineChart data={chartSeries} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="label"
                      interval="preserveStartEnd"
                      minTickGap={20}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis width={44} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <RechartsTooltip contentStyle={{ borderRadius: 12, border: "1px solid hsl(var(--border))" }} />
                    <Line type="monotone" dataKey="orders" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
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
                                <TableCell key={j} className="font-body text-xs max-w-[200px] truncate" title={String(cell)}>
                                  {String(cell)}
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
