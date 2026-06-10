import { useEffect, useMemo, useState } from "react";
import { DashboardOverviewSummaryCard } from "@/components/DashboardOverviewSummaryCard";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import {
  useAggregateFinancialBreakdownForViewers,
  useAggregateShopifyAnalyticsDashboardForViewers,
  useShopifyAnalyticsDashboard,
  useSelectedSalespeopleShopifyAnalyticsDashboard,
  shopifyAnalyticsToSalesBreakdown,
  emptyShopifyAnalyticsDashboard,
  useScopeFinancialBreakdown,
  useScopeOrderTimeseries,
  useSalespersonFinancialBreakdown,
  useSupervisorSelectedManagerTimeseries,
  useSupervisorManagerScopePerformance,
  useSupervisorSalespersonOptions,
  useSalespeopleScopedMetricsAndSeries,
  useSalespeopleUnderManagers,
  useScopedUserOptions,
} from "@/hooks/use-shopify-data";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";
import { formatOrderMoney } from "@/lib/format";
import { getDashboardRange, toRangeIso, trendTitleForPreset, type DatePreset } from "@/lib/dashboard-date-range";
import { PeriodSelectItems } from "@/components/PeriodSelectItems";
import { differenceInCalendarDays } from "date-fns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { loadUserFilterPreset, saveUserFilterPreset } from "@/lib/filter-preset-storage";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

type ManagerScopeRow = {
  viewer_user_id: string;
  viewer_role: string | null;
  team_member_count: number;
  team_customers_count: number;
  team_orders_count: number;
  team_revenue: number;
  manager_name: string;
};

export default function SupervisorDashboardPage() {
  const { user } = useAuth();
  const scopeKey = user?.id ?? "supervisor";
  const { data: currency = "GBP" } = useShopDisplayCurrency();
  const [preset, setPreset] = useState<DatePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [scopeMode, setScopeMode] = useState<"all" | "manager_team" | "salesperson" | "mine">("mine");
  const [selectedManagerId, setSelectedManagerId] = useState("all");
  const [selectedSalespersonId, setSelectedSalespersonId] = useState("all");
  const [quickManagerFilter, setQuickManagerFilter] = useState<"all" | "top3" | "bottom3">("all");
  const [compareEnabled, setCompareEnabled] = useState(false);

  useEffect(() => {
    const saved = loadUserFilterPreset(user?.id, "supervisor-dashboard", {
      preset: "month" as DatePreset,
      customFrom: "",
      customTo: "",
      scopeMode: "mine" as "all" | "manager_team" | "salesperson" | "mine",
      selectedManagerId: "all",
      selectedSalespersonId: "all",
      quickManagerFilter: "all" as "all" | "top3" | "bottom3",
      compareEnabled: false,
    });
    setPreset(saved.preset);
    setCustomFrom(saved.customFrom);
    setCustomTo(saved.customTo);
    setScopeMode(saved.scopeMode);
    setSelectedManagerId(saved.selectedManagerId);
    setSelectedSalespersonId(saved.selectedSalespersonId);
    setQuickManagerFilter(saved.quickManagerFilter);
    setCompareEnabled(Boolean(saved.compareEnabled));
  }, [user?.id]);

  useEffect(() => {
    saveUserFilterPreset(user?.id, "supervisor-dashboard", {
      preset,
      customFrom,
      customTo,
      scopeMode,
      selectedManagerId,
      selectedSalespersonId,
      quickManagerFilter,
      compareEnabled,
    });
  }, [user?.id, preset, customFrom, customTo, scopeMode, selectedManagerId, selectedSalespersonId, quickManagerFilter, compareEnabled]);

  const range = useMemo(
    () => getDashboardRange(preset, customFrom || undefined, customTo || undefined),
    [preset, customFrom, customTo],
  );
  const fromIso = toRangeIso(range.from);
  const toIso = toRangeIso(range.to);
  const rangeDays =
    range.from && range.to ? Math.max(1, differenceInCalendarDays(range.to, range.from) + 1) : 365;
  const bucket = rangeDays <= 62 ? "day" : "month";
  const trendTitle = useMemo(() => trendTitleForPreset(preset), [preset]);

  const { data: managerRows = [], isLoading: loadingManagers } = useSupervisorManagerScopePerformance(
    user?.id,
    "supervisor",
    fromIso,
    toIso,
  );
  const typedRows = managerRows as ManagerScopeRow[];
  const managerOptions = useMemo(
    () =>
      typedRows.map((row) => ({
        user_id: row.viewer_user_id,
        label: row.manager_name || "Manager",
      })),
    [typedRows],
  );
  const { data: salespersonOptions = [] } = useSupervisorSalespersonOptions(user?.id, scopeKey);
  const { data: managerSalespeople = [] } = useSalespeopleUnderManagers(
    selectedManagerId !== "all" ? [selectedManagerId] : [],
    `${scopeKey}-manager-salespeople`,
    selectedManagerId !== "all",
  );
  const { data: managerSalespersonOptions = [] } = useScopedUserOptions(
    user?.id,
    managerSalespeople,
    `${scopeKey}-manager-salespeople-options`,
    selectedManagerId !== "all" && managerSalespeople.length > 0,
  );
  const filteredSalespersonOptions = useMemo(
    () =>
      selectedManagerId === "all"
        ? salespersonOptions
        : managerSalespersonOptions,
    [selectedManagerId, salespersonOptions, managerSalespersonOptions],
  );
  const { data: allMetrics, isLoading: loadingAllMetrics } = useScopeFinancialBreakdown(
    user?.id,
    fromIso,
    toIso,
    Boolean(user?.id),
  );
  const { data: allSeries = [], isLoading: loadingAllSeries } = useScopeOrderTimeseries(
    user?.id,
    fromIso,
    toIso,
    bucket,
    "supervisor",
    Boolean(user?.id) && scopeMode === "all",
  );
  /** "Mine" KPIs use viewer aggregation; the supervisor-selected-manager timeseries only accepts manager UUIDs, so use the same single-viewer series as the rest of the app. */
  const { data: mineScopeSeries = [], isLoading: loadingMineScopeSeries } = useScopeOrderTimeseries(
    user?.id,
    fromIso,
    toIso,
    bucket,
    `${scopeKey}-mine`,
    Boolean(user?.id) && scopeMode === "mine",
  );

  const selectedViewerIds = useMemo(() => {
    if (scopeMode === "manager_team" && selectedManagerId !== "all") return [selectedManagerId];
    if (scopeMode === "manager_team" && selectedManagerId === "all") return managerOptions.map((m) => m.user_id);
    if (scopeMode === "mine" && user?.id) return [user.id];
    return [];
  }, [scopeMode, selectedManagerId, user?.id, managerOptions]);
  const selectedSalespersonIds = useMemo(() => {
    if (scopeMode !== "salesperson" && scopeMode !== "manager_team") return [] as string[];
    if (selectedSalespersonId !== "all") return [selectedSalespersonId];
    return filteredSalespersonOptions.map((s) => s.user_id);
  }, [scopeMode, selectedSalespersonId, filteredSalespersonOptions]);
  const isSalespersonDrilldown = (scopeMode === "salesperson" || scopeMode === "manager_team") && selectedSalespersonId !== "all";
  const drilledSalespersonId = isSalespersonDrilldown ? selectedSalespersonId : undefined;
  const { data: aggregatedScopedMetrics, isLoading: loadingAggregatedScopedMetrics } = useAggregateFinancialBreakdownForViewers(
    selectedViewerIds,
    fromIso,
    toIso,
    scopeKey,
    scopeMode !== "all",
  );
  const { data: salespersonScopedData, isLoading: loadingSalespersonScopedData } = useSalespeopleScopedMetricsAndSeries(
    selectedSalespersonIds,
    fromIso,
    toIso,
    bucket,
    scopeKey,
    scopeMode === "salesperson" || isSalespersonDrilldown,
  );
  const { data: drilledSalespersonMetrics, isLoading: loadingDrilledSalespersonMetrics } = useScopeFinancialBreakdown(
    drilledSalespersonId,
    fromIso,
    toIso,
    isSalespersonDrilldown && Boolean(drilledSalespersonId),
  );
  const { data: drilledSalespersonSeries = [], isLoading: loadingDrilledSalespersonSeries } = useScopeOrderTimeseries(
    drilledSalespersonId,
    fromIso,
    toIso,
    bucket,
    `${scopeKey}-drilled-salesperson`,
    isSalespersonDrilldown && Boolean(drilledSalespersonId),
  );
  const { data: selectedManagerSeries = [], isLoading: loadingSelectedSeries } = useSupervisorSelectedManagerTimeseries(
    user?.id,
    selectedViewerIds,
    fromIso,
    toIso,
    bucket,
    scopeKey,
    scopeMode !== "all" && scopeMode !== "mine",
  );
  const selectedManagerTeamEnabled = scopeMode === "manager_team" && selectedManagerId !== "all";
  /** Same engine as Manager Dashboard: financial breakdown for direct reports. */
  const { data: teamBreakdownRows = [], isLoading: loadingTeamBreakdown } = useSalespersonFinancialBreakdown(
    `${scopeKey}-manager-${selectedManagerId}-team`,
    fromIso,
    toIso,
    selectedManagerId !== "all" ? selectedManagerId : null,
    "manager",
    Boolean(user?.id) && selectedManagerTeamEnabled,
  );
  /** Manager self row uses scoped salesperson metrics (assignments + name fallback), not cumulative scope. */
  const { data: managerSelfMetrics, isLoading: loadingManagerSelfMetrics } = useSalespeopleScopedMetricsAndSeries(
    selectedManagerId !== "all" ? [selectedManagerId] : [],
    fromIso,
    toIso,
    bucket,
    `${scopeKey}-manager-self-${selectedManagerId}`,
    Boolean(user?.id) && selectedManagerTeamEnabled,
  );

  const metrics =
    scopeMode === "all"
      ? allMetrics
      : isSalespersonDrilldown
        ? drilledSalespersonMetrics
        : scopeMode === "salesperson"
        ? salespersonScopedData
        : aggregatedScopedMetrics;
  const series =
    scopeMode === "all"
      ? allSeries
      : scopeMode === "mine"
        ? mineScopeSeries
        : isSalespersonDrilldown
          ? drilledSalespersonSeries
          : scopeMode === "salesperson"
            ? salespersonScopedData?.series ?? []
            : selectedManagerSeries;
  const loadingMetrics =
    scopeMode === "all"
      ? loadingAllMetrics
      : isSalespersonDrilldown
        ? loadingDrilledSalespersonMetrics
        : scopeMode === "salesperson"
        ? loadingSalespersonScopedData
        : loadingAggregatedScopedMetrics;
  const loadingSeries =
    scopeMode === "all"
      ? loadingAllSeries
      : scopeMode === "mine"
        ? loadingMineScopeSeries
        : isSalespersonDrilldown
          ? loadingDrilledSalespersonSeries
          : scopeMode === "salesperson"
            ? loadingSalespersonScopedData
            : loadingSelectedSeries;

  const { data: analyticsAll, isLoading: loadingAnalyticsAll } = useShopifyAnalyticsDashboard(
    user?.id,
    fromIso,
    toIso,
    Boolean(user?.id) && scopeMode === "all",
  );
  const { data: analyticsAggregate, isLoading: loadingAnalyticsAggregate } =
    useAggregateShopifyAnalyticsDashboardForViewers(
      selectedViewerIds,
      fromIso,
      toIso,
      scopeKey,
      Boolean(user?.id) &&
        (scopeMode === "mine" || scopeMode === "manager_team") &&
        !isSalespersonDrilldown &&
        selectedViewerIds.length > 0,
    );
  const { data: analyticsSalespeople, isLoading: loadingAnalyticsSalespeople } =
    useSelectedSalespeopleShopifyAnalyticsDashboard(
      user?.id,
      selectedSalespersonIds,
      fromIso,
      toIso,
      Boolean(user?.id) &&
        scopeMode === "salesperson" &&
        !isSalespersonDrilldown &&
        selectedSalespersonIds.length > 0,
    );
  const { data: analyticsDrill, isLoading: loadingAnalyticsDrill } = useShopifyAnalyticsDashboard(
    drilledSalespersonId,
    fromIso,
    toIso,
    Boolean(user?.id && drilledSalespersonId) && isSalespersonDrilldown,
  );

  const analytics = useMemo(() => {
    if (scopeMode === "all") return analyticsAll ?? emptyShopifyAnalyticsDashboard();
    if (isSalespersonDrilldown) return analyticsDrill ?? emptyShopifyAnalyticsDashboard();
    if (scopeMode === "salesperson") return analyticsSalespeople ?? emptyShopifyAnalyticsDashboard();
    return analyticsAggregate ?? emptyShopifyAnalyticsDashboard();
  }, [scopeMode, isSalespersonDrilldown, analyticsAll, analyticsDrill, analyticsSalespeople, analyticsAggregate]);

  const shopifySalesBreakdown = useMemo(
    () => shopifyAnalyticsToSalesBreakdown(analytics),
    [analytics],
  );

  const loadingAnalytics =
    scopeMode === "all"
      ? loadingAnalyticsAll
      : isSalespersonDrilldown
        ? loadingAnalyticsDrill
        : scopeMode === "salesperson"
          ? loadingAnalyticsSalespeople
          : loadingAnalyticsAggregate;

  const quickScopedIds = useMemo(() => {
    if (quickManagerFilter === "all") return null;
    const ranked = [...typedRows].sort((a, b) => Number(b.team_revenue || 0) - Number(a.team_revenue || 0));
    const sliced = quickManagerFilter === "top3" ? ranked.slice(0, 3) : ranked.slice(-3);
    return new Set(sliced.map((r) => r.viewer_user_id));
  }, [typedRows, quickManagerFilter]);
  const filteredRows = useMemo(() => {
    let rows = typedRows;
    if (scopeMode === "manager_team" && selectedManagerId !== "all") {
      rows = rows.filter((row) => row.viewer_user_id === selectedManagerId);
    }
    if (scopeMode === "mine" && user?.id) rows = rows.filter((row) => row.viewer_user_id === user.id);
    if (quickScopedIds) rows = rows.filter((row) => quickScopedIds.has(row.viewer_user_id));
    return rows;
  }, [scopeMode, selectedManagerId, typedRows, user?.id, quickScopedIds]);
  type TeamBreakdownRow = {
    salesperson_user_id: string;
    salesperson_name: string;
    customers_count: number;
    orders_count: number;
    revenue: number;
    is_manager_row: boolean;
  };

  const selectedManagerLabel =
    managerOptions.find((m) => m.user_id === selectedManagerId)?.label ?? "Manager";

  const managerSelfRow = useMemo((): TeamBreakdownRow | null => {
    if (!selectedManagerTeamEnabled || !managerSelfMetrics) return null;
    return {
      salesperson_user_id: selectedManagerId,
      salesperson_name: `${selectedManagerLabel} (Manager)`,
      customers_count: Number(managerSelfMetrics.customers_count || 0),
      orders_count: Number(managerSelfMetrics.orders_total_count || managerSelfMetrics.orders_count || 0),
      revenue: Number(managerSelfMetrics.current_gross_sales || managerSelfMetrics.revenue || 0),
      is_manager_row: true,
    };
  }, [selectedManagerTeamEnabled, managerSelfMetrics, selectedManagerId, selectedManagerLabel]);

  const teamRows = useMemo(
    (): TeamBreakdownRow[] =>
      teamBreakdownRows.map((row) => ({
        salesperson_user_id: row.salesperson_user_id,
        salesperson_name: row.salesperson_name,
        customers_count: Number(row.customers_count || 0),
        orders_count: Number(row.orders_total_count || 0),
        revenue: Number(row.current_gross_sales || 0),
        is_manager_row: false,
      })),
    [teamBreakdownRows],
  );

  const selectedManagerTableRows = useMemo(() => {
    let rows: TeamBreakdownRow[] = managerSelfRow ? [managerSelfRow, ...teamRows] : teamRows;
    if (selectedSalespersonId !== "all") {
      rows = rows.filter((row) => row.salesperson_user_id === selectedSalespersonId);
    }
    return rows;
  }, [managerSelfRow, teamRows, selectedSalespersonId]);

  const breakdownTotals = useMemo(
    () =>
      selectedManagerTableRows.reduce(
        (acc, row) => {
          acc.customers_count += row.customers_count;
          acc.orders_count += row.orders_count;
          acc.revenue += row.revenue;
          return acc;
        },
        { customers_count: 0, orders_count: 0, revenue: 0 },
      ),
    [selectedManagerTableRows],
  );

  useEffect(() => {
    if (selectedSalespersonId === "all") return;
    if (filteredSalespersonOptions.some((s) => s.user_id === selectedSalespersonId)) return;
    setSelectedSalespersonId("all");
  }, [filteredSalespersonOptions, selectedSalespersonId]);

  return (
    <div className="w-full space-y-6">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Supervisor Dashboard</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">Manager-level oversight with downstream team performance.</p>
      </div>

      <div className="card-float p-4 opacity-0 animate-fade-in flex flex-col gap-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground font-body mb-1.5">Period</p>
            <Select value={preset} onValueChange={(v) => setPreset(v as DatePreset)}>
              <SelectTrigger className="rounded-xl h-10 font-body">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <PeriodSelectItems includeAll={false} />
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground font-body mb-1.5">Scope</p>
            <Select
              value={scopeMode}
              onValueChange={(v) => {
                setScopeMode(v as "all" | "manager_team" | "salesperson" | "mine");
                if (v !== "manager_team") setSelectedManagerId("all");
                if (v === "all" || v === "mine") setSelectedSalespersonId("all");
              }}
            >
              <SelectTrigger className="rounded-xl h-10 font-body">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mine">Mine</SelectItem>
                <SelectItem value="all">My Team</SelectItem>
                <SelectItem value="manager_team">Manager Team</SelectItem>
                <SelectItem value="salesperson">Salesperson</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground font-body mb-1.5">Manager</p>
            <Select value={selectedManagerId} onValueChange={setSelectedManagerId} disabled={scopeMode !== "manager_team"}>
              <SelectTrigger className="rounded-xl h-10 font-body">
                <SelectValue placeholder="Manager" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Select manager</SelectItem>
                {managerOptions.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground font-body mb-1.5">Salesperson</p>
            <Select
              value={selectedSalespersonId}
              onValueChange={setSelectedSalespersonId}
              disabled={scopeMode !== "salesperson" && scopeMode !== "manager_team"}
            >
              <SelectTrigger className="rounded-xl h-10 font-body">
                <SelectValue placeholder="Salesperson" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Select salesperson</SelectItem>
                {filteredSalespersonOptions.map((s) => (
                  <SelectItem key={s.user_id} value={s.user_id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {preset === "custom" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-10 rounded-xl border bg-card px-3 text-sm font-body"
            />
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-10 rounded-xl border bg-card px-3 text-sm font-body"
            />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setQuickManagerFilter("all")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body transition-colors ${quickManagerFilter === "all" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>All</button>
          <button onClick={() => setQuickManagerFilter("top3")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body transition-colors ${quickManagerFilter === "top3" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Top 3</button>
          <button onClick={() => setQuickManagerFilter("bottom3")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body transition-colors ${quickManagerFilter === "bottom3" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Bottom 3</button>
          <button onClick={() => setCompareEnabled((v) => !v)} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body transition-colors ${compareEnabled ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Compare vs my team</button>
        </div>
      </div>

      {compareEnabled && scopeMode !== "all" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="card-float p-4">
            <p className="text-xs text-muted-foreground font-body">Selected scope total sales</p>
            <p className="text-xl font-heading font-bold">{formatOrderMoney(analytics?.total_sales || 0, null, currency)}</p>
          </div>
          <div className="card-float p-4">
            <p className="text-xs text-muted-foreground font-body">Full scope total sales</p>
            <p className="text-xl font-heading font-bold">{formatOrderMoney(analyticsAll?.total_sales || 0, null, currency)}</p>
          </div>
        </div>
      )}

      <DashboardOverviewSummaryCard
        currency={currency}
        delayBase={50}
        salesBreakdown={shopifySalesBreakdown}
        loadingSales={loadingAnalytics}
        totalOrders={analytics?.orders_total ?? 0}
        paidOrders={analytics?.orders_paid ?? 0}
        pendingOrders={analytics?.orders_pending ?? 0}
        refundedOrders={analytics?.orders_refunded ?? 0}
        unfulfilledOrders={analytics?.orders_unfulfilled ?? 0}
        loadingOrders={loadingAnalytics}
        loadingUnfulfilled={loadingAnalytics}
        totalCustomers={analytics?.customers_count ?? 0}
        loadingCustomers={loadingAnalytics}
      />

      <div className="card-float p-5 opacity-0 animate-fade-in min-w-0">
        <h3 className="font-heading font-semibold text-foreground mb-4">{trendTitle}</h3>
        {loadingSeries ? (
          <Skeleton className="h-[220px] w-full rounded-xl" />
        ) : series.length === 0 ? (
          <p className="text-sm text-muted-foreground font-body py-10 text-center">No trend data available yet.</p>
        ) : (
          <div className="h-[220px] min-h-[220px] min-w-0 w-full">
            <ResponsiveContainer width="100%" height={220} minWidth={0} minHeight={220}>
              <AreaChart data={series}>
                <defs>
                  <linearGradient id="supervisorRevenueGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.36} />
                    <stop offset="65%" stopColor="hsl(var(--primary))" stopOpacity={0.14} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => formatOrderMoney(v, null, currency)} />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2.5}
                  fill="url(#supervisorRevenueGradient)"
                  fillOpacity={1}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="card-float p-5 opacity-0 animate-fade-in">
        {scopeMode === "manager_team" && selectedManagerId !== "all" ? (
          <div className="mt-5 space-y-3">
            {loadingTeamBreakdown || loadingManagerSelfMetrics ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-full rounded-lg" />
                <Skeleton className="h-9 w-full rounded-lg" />
              </div>
            ) : selectedManagerTableRows.length === 0 ? (
              <p className="text-sm text-muted-foreground font-body">
                No team member rows found for the selected manager in this period.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full text-sm font-body">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left py-2.5 px-3 font-medium">Salesperson</th>
                      <th className="text-right py-2.5 px-3 font-medium">Registered Customers</th>
                      <th className="text-right py-2.5 px-3 font-medium">Orders</th>
                      <th className="text-right py-2.5 px-3 font-medium">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedManagerTableRows.map((row) => (
                      <tr
                        key={`${row.salesperson_user_id}-${row.is_manager_row ? "manager" : "team"}`}
                        className={`border-b last:border-0 ${row.is_manager_row ? "bg-muted/60" : ""}`}
                      >
                        <td className="py-3 px-3">{row.salesperson_name}</td>
                        <td className="py-3 px-3 text-right">{row.customers_count}</td>
                        <td className="py-3 px-3 text-right">{row.orders_count}</td>
                        <td className="py-3 px-3 text-right">{formatOrderMoney(row.revenue, null, currency)}</td>
                      </tr>
                    ))}
                    {selectedManagerTableRows.length > 1 && selectedSalespersonId === "all" && (
                      <tr className="border-t-2 border-foreground/20 font-semibold bg-muted/30">
                        <td className="py-3 px-3">Breakdown total</td>
                        <td className="py-3 px-3 text-right">{breakdownTotals.customers_count}</td>
                        <td className="py-3 px-3 text-right">{breakdownTotals.orders_count}</td>
                        <td className="py-3 px-3 text-right">{formatOrderMoney(breakdownTotals.revenue, null, currency)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground font-body">
            Select <span className="font-medium">Manager Team</span> scope and choose a manager to view the detailed breakdown.
          </p>
        )}
      </div>
    </div>
  );
}
