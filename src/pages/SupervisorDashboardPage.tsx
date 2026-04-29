import { useEffect, useMemo, useState } from "react";
import { Users, ShoppingCart, PoundSterling, TrendingUp } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import {
  useAggregateScopeMetricsForViewers,
  useScopeOrderTimeseries,
  useScopeOrderMetrics,
  useSupervisorSelectedManagerTimeseries,
  useSupervisorManagerScopePerformance,
  useSupervisorSalespersonOptions,
  useSalespeopleScopedMetricsAndSeries,
  useSalespeopleUnderManagers,
  useScopedUserOptions,
} from "@/hooks/use-shopify-data";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";
import { formatOrderMoney } from "@/lib/format";
import { getDashboardRange, toRangeIso, type DatePreset } from "@/lib/dashboard-date-range";
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
  const trendTitle = useMemo(() => {
    switch (preset) {
      case "today":
        return "Today Trend";
      case "week":
        return "Last 7 Days Trend";
      case "month":
        return "This Month Trend";
      case "quarter":
        return "This Quarter Trend";
      case "year":
        return "This Year Trend";
      case "custom":
        return "Custom Range Trend";
      default:
        return "Trend";
    }
  }, [preset]);

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
  const { data: allMetrics, isLoading: loadingAllMetrics } = useScopeOrderMetrics(
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
  const { data: aggregatedScopedMetrics, isLoading: loadingAggregatedScopedMetrics } = useAggregateScopeMetricsForViewers(
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
  const { data: drilledSalespersonMetrics, isLoading: loadingDrilledSalespersonMetrics } = useScopeOrderMetrics(
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
    scopeMode !== "all",
  );

  const scopedMetricsFromSeries = useMemo(() => {
    if (scopeMode === "all") return null;
    if (!selectedManagerSeries.length) return null;
    const revenue = selectedManagerSeries.reduce((sum, point) => sum + Number(point.revenue || 0), 0);
    const ordersCount = selectedManagerSeries.reduce((sum, point) => sum + Number(point.orders || 0), 0);
    const customersCount = Number(aggregatedScopedMetrics?.customers_count || 0);
    return {
      orders_count: ordersCount,
      customers_count: customersCount,
      revenue,
      avg_order_value: ordersCount > 0 ? revenue / ordersCount : 0,
    };
  }, [scopeMode, selectedManagerSeries, aggregatedScopedMetrics?.customers_count]);
  const metrics =
    scopeMode === "all"
      ? allMetrics
      : isSalespersonDrilldown
        ? drilledSalespersonMetrics
        : scopeMode === "salesperson"
        ? salespersonScopedData
        : scopedMetricsFromSeries ?? aggregatedScopedMetrics;
  const series =
    scopeMode === "all"
      ? allSeries
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
      : isSalespersonDrilldown
        ? loadingDrilledSalespersonSeries
        : scopeMode === "salesperson"
        ? loadingSalespersonScopedData
        : loadingSelectedSeries;
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
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="week">Last 7 days</SelectItem>
                <SelectItem value="month">This month</SelectItem>
                <SelectItem value="quarter">This quarter</SelectItem>
                <SelectItem value="year">This year</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
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
            <p className="text-xs text-muted-foreground font-body">Selected Scope Revenue</p>
            <p className="text-xl font-heading font-bold">{formatOrderMoney(metrics?.revenue || 0, null, currency)}</p>
          </div>
          <div className="card-float p-4">
            <p className="text-xs text-muted-foreground font-body">Full Scope Revenue</p>
            <p className="text-xl font-heading font-bold">{formatOrderMoney(allMetrics?.revenue || 0, null, currency)}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
        <KpiCard title="Org Revenue (Scope)" value={loadingMetrics ? <Skeleton className="h-8 w-20 rounded-md" /> : formatOrderMoney(metrics?.revenue || 0, null, currency)} icon={PoundSterling} info="Current scope revenue from order totals for selected period." delay={50} />
        <KpiCard title="Org Orders (Scope)" value={loadingMetrics ? <Skeleton className="h-8 w-16 rounded-md" /> : String(metrics?.orders_count || 0)} icon={ShoppingCart} info="Current scope order count for selected period." delay={100} />
        <KpiCard title="Org Customers (Scope)" value={loadingMetrics ? <Skeleton className="h-8 w-16 rounded-md" /> : String(metrics?.customers_count || 0)} icon={Users} info="Current scope customer count for selected period." delay={150} />
        <KpiCard title="Avg Order" value={loadingMetrics ? <Skeleton className="h-8 w-20 rounded-md" /> : formatOrderMoney(metrics?.avg_order_value || 0, null, currency)} icon={TrendingUp} info="Revenue divided by order count for the selected scope." delay={200} />
      </div>

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
        <h3 className="font-heading font-semibold text-foreground mb-4">Manager Scorecards</h3>
        {scopeMode === "salesperson" ? (
          <p className="text-sm text-muted-foreground font-body">Manager scorecards are hidden in salesperson scope.</p>
        ) : loadingManagers ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ) : filteredRows.length === 0 ? (
          <p className="text-sm text-muted-foreground font-body">No manager reporting lines found for this supervisor.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-body">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-2.5 font-medium">Manager</th>
                  <th className="text-right py-2.5 font-medium">Team members</th>
                  <th className="text-right py-2.5 font-medium">Customers</th>
                  <th className="text-right py-2.5 font-medium">Orders</th>
                  <th className="text-right py-2.5 font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.viewer_user_id} className="border-b last:border-0">
                    <td className="py-3">{row.manager_name}</td>
                    <td className="py-3 text-right">{row.team_member_count}</td>
                    <td className="py-3 text-right">{row.team_customers_count}</td>
                    <td className="py-3 text-right">{row.team_orders_count}</td>
                    <td className="py-3 text-right">{formatOrderMoney(row.team_revenue, null, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
