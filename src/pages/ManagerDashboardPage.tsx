import { useEffect, useMemo, useState } from "react";
import { Users, ShoppingCart, DollarSign, TrendingUp } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import {
  useDirectReportSalesPerformance,
  useManagerSelectedSalespeopleTimeseries,
  useManagerTeamMemberOptions,
  useScopeOrderTimeseries,
  useSalespeopleScopedMetricsAndSeries,
  useScopeOrderMetrics,
} from "@/hooks/use-shopify-data";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";
import { formatOrderMoney } from "@/lib/format";
import { getDashboardRange, toRangeIso, type DatePreset } from "@/lib/dashboard-date-range";
import { differenceInCalendarDays } from "date-fns";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { loadUserFilterPreset, saveUserFilterPreset } from "@/lib/filter-preset-storage";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

export default function ManagerDashboardPage() {
  const { user } = useAuth();
  const scopeKey = user?.id ?? "manager";
  const { data: currency = "GBP" } = useShopDisplayCurrency();
  const [preset, setPreset] = useState<DatePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [scopeMode, setScopeMode] = useState<"team" | "salesperson" | "mine">("team");
  const [selectedSalespersonId, setSelectedSalespersonId] = useState("all");
  const [quickMemberFilter, setQuickMemberFilter] = useState<"all" | "top3" | "bottom3">("all");
  const [compareEnabled, setCompareEnabled] = useState(false);

  useEffect(() => {
    const saved = loadUserFilterPreset(user?.id, "manager-dashboard", {
      preset: "month" as DatePreset,
      customFrom: "",
      customTo: "",
      scopeMode: "team" as "team" | "salesperson" | "mine",
      selectedSalespersonId: "all",
      quickMemberFilter: "all" as "all" | "top3" | "bottom3",
      compareEnabled: false,
    });
    setPreset(saved.preset);
    setCustomFrom(saved.customFrom);
    setCustomTo(saved.customTo);
    setScopeMode(saved.scopeMode);
    setSelectedSalespersonId(saved.selectedSalespersonId);
    setQuickMemberFilter(saved.quickMemberFilter);
    setCompareEnabled(Boolean(saved.compareEnabled));
  }, [user?.id]);

  useEffect(() => {
    saveUserFilterPreset(user?.id, "manager-dashboard", {
      preset,
      customFrom,
      customTo,
      scopeMode,
      selectedSalespersonId,
      quickMemberFilter,
      compareEnabled,
    });
  }, [user?.id, preset, customFrom, customTo, scopeMode, selectedSalespersonId, quickMemberFilter, compareEnabled]);

  const range = useMemo(
    () => getDashboardRange(preset, customFrom || undefined, customTo || undefined),
    [preset, customFrom, customTo],
  );
  const fromIso = toRangeIso(range.from);
  const toIso = toRangeIso(range.to);
  const rangeDays =
    range.from && range.to ? Math.max(1, differenceInCalendarDays(range.to, range.from) + 1) : 365;
  const bucket = rangeDays <= 62 ? "day" : "month";

  const { data: teamMemberOptions = [] } = useManagerTeamMemberOptions(user?.id, scopeKey);
  const { data: teamRows = [], isLoading: loadingTeam } = useDirectReportSalesPerformance(user?.id, "manager", "manager");
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
    "manager",
    Boolean(user?.id) && scopeMode === "team",
  );

  const scopedSalespersonIds = useMemo(() => {
    if (!user?.id) return [] as string[];
    if (scopeMode === "mine") return [user.id];
    if (scopeMode === "salesperson" && selectedSalespersonId !== "all") return [selectedSalespersonId];
    return [];
  }, [scopeMode, selectedSalespersonId, user?.id]);

  const { data: scopedData, isLoading: loadingScopedData } = useSalespeopleScopedMetricsAndSeries(
    scopedSalespersonIds,
    fromIso,
    toIso,
    bucket,
    scopeKey,
    scopeMode !== "team",
  );
  const { data: selectedSeries = [], isLoading: loadingSelectedSeries } = useManagerSelectedSalespeopleTimeseries(
    user?.id,
    scopedSalespersonIds,
    fromIso,
    toIso,
    bucket,
    scopeKey,
    scopeMode !== "team",
  );

  const scopedMetricsFromSeries = useMemo(() => {
    if (scopeMode === "team") return null;
    if (!selectedSeries.length) return null;
    const revenue = selectedSeries.reduce((sum, point) => sum + Number(point.revenue || 0), 0);
    const ordersCount = selectedSeries.reduce((sum, point) => sum + Number(point.orders || 0), 0);
    const customersCount = Number(scopedData?.customers_count || 0);
    return {
      orders_count: ordersCount,
      customers_count: customersCount,
      revenue,
      avg_order_value: ordersCount > 0 ? revenue / ordersCount : 0,
    };
  }, [scopeMode, selectedSeries, scopedData?.customers_count]);

  const metrics = scopeMode === "team" ? allMetrics : scopedMetricsFromSeries ?? scopedData;
  const series = scopeMode === "team" ? allSeries : selectedSeries;
  const loadingMetrics = scopeMode === "team" ? loadingAllMetrics : loadingScopedData || loadingSelectedSeries;
  const loadingSeries = scopeMode === "team" ? loadingAllSeries : loadingSelectedSeries;
  const quickScopedIds = useMemo(() => {
    if (quickMemberFilter === "all") return null;
    const ranked = [...teamRows].sort((a, b) => Number(b.revenue || 0) - Number(a.revenue || 0));
    const sliced = quickMemberFilter === "top3" ? ranked.slice(0, 3) : ranked.slice(-3);
    return new Set(sliced.map((r) => r.salesperson_user_id));
  }, [teamRows, quickMemberFilter]);

  const filteredTeamRows = useMemo(() => {
    let rows = teamRows;
    if (scopeMode === "salesperson" && selectedSalespersonId !== "all") {
      rows = rows.filter((row) => row.salesperson_user_id === selectedSalespersonId);
    }
    if (scopeMode === "mine" && user?.id) {
      rows = rows.filter((row) => row.salesperson_user_id === user.id);
    }
    if (quickScopedIds) {
      rows = rows.filter((row) => quickScopedIds.has(row.salesperson_user_id));
    }
    return rows;
  }, [scopeMode, selectedSalespersonId, teamRows, user?.id, quickScopedIds]);

  return (
    <div className="w-full space-y-6">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Manager Dashboard</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">Your sales performance and direct-report team outcomes.</p>
      </div>

      <div className="card-float p-4 opacity-0 animate-fade-in flex flex-col gap-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
                setScopeMode(v as "team" | "salesperson" | "mine");
                if (v !== "salesperson") setSelectedSalespersonId("all");
              }}
            >
              <SelectTrigger className="rounded-xl h-10 font-body">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mine">Mine</SelectItem>
                <SelectItem value="team">My Team</SelectItem>
                <SelectItem value="salesperson">Salesperson</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground font-body mb-1.5">Salesperson</p>
            <Select value={selectedSalespersonId} onValueChange={setSelectedSalespersonId} disabled={scopeMode !== "salesperson"}>
              <SelectTrigger className="rounded-xl h-10 font-body">
                <SelectValue placeholder="Salesperson" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Select salesperson</SelectItem>
                {teamMemberOptions.map((member) => (
                  <SelectItem key={member.user_id} value={member.user_id}>
                    {member.label}
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
          <button onClick={() => setQuickMemberFilter("all")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body transition-colors ${quickMemberFilter === "all" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>All</button>
          <button onClick={() => setQuickMemberFilter("top3")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body transition-colors ${quickMemberFilter === "top3" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Top 3</button>
          <button onClick={() => setQuickMemberFilter("bottom3")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body transition-colors ${quickMemberFilter === "bottom3" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Bottom 3</button>
          <button onClick={() => setCompareEnabled((v) => !v)} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body transition-colors ${compareEnabled ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Compare vs full team</button>
        </div>
      </div>

      {compareEnabled && scopeMode !== "team" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="card-float p-4">
            <p className="text-xs text-muted-foreground font-body">Selected Scope Revenue</p>
            <p className="text-xl font-heading font-bold">{formatOrderMoney(metrics?.revenue || 0, null, currency)}</p>
          </div>
          <div className="card-float p-4">
            <p className="text-xs text-muted-foreground font-body">Full Team Revenue</p>
            <p className="text-xl font-heading font-bold">{formatOrderMoney(allMetrics?.revenue || 0, null, currency)}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
        <KpiCard title="Team Revenue" value={loadingMetrics ? <Skeleton className="h-8 w-20 rounded-md" /> : formatOrderMoney(metrics?.revenue || 0, null, currency)} icon={DollarSign} delay={50} />
        <KpiCard title="Team Orders" value={loadingMetrics ? <Skeleton className="h-8 w-16 rounded-md" /> : String(metrics?.orders_count || 0)} icon={ShoppingCart} delay={100} />
        <KpiCard title="Team Customers" value={loadingMetrics ? <Skeleton className="h-8 w-16 rounded-md" /> : String(metrics?.customers_count || 0)} icon={Users} delay={150} />
        <KpiCard title="Avg Order" value={loadingMetrics ? <Skeleton className="h-8 w-20 rounded-md" /> : formatOrderMoney(metrics?.avg_order_value || 0, null, currency)} icon={TrendingUp} delay={200} />
      </div>

      <div className="card-float p-5 opacity-0 animate-fade-in min-w-0">
        <h3 className="font-heading font-semibold text-foreground mb-4">Last 3 Months Trend</h3>
        {loadingSeries ? (
          <Skeleton className="h-[220px] w-full rounded-xl" />
        ) : series.length === 0 ? (
          <p className="text-sm text-muted-foreground font-body py-10 text-center">No trend data available yet.</p>
        ) : (
          <div className="h-[220px] min-h-[220px] min-w-0 w-full">
            <ResponsiveContainer width="100%" height={220} minWidth={0} minHeight={220}>
              <BarChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => formatOrderMoney(v, null, currency)} />
                <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="card-float p-5 opacity-0 animate-fade-in">
        <h3 className="font-heading font-semibold text-foreground mb-4">Direct Reports Performance</h3>
        {loadingTeam ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ) : filteredTeamRows.length === 0 ? (
          <p className="text-sm text-muted-foreground font-body">No direct report assignments found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-body">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-2.5 font-medium">Salesperson</th>
                  <th className="text-right py-2.5 font-medium">Customers</th>
                  <th className="text-right py-2.5 font-medium">Orders</th>
                  <th className="text-right py-2.5 font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {filteredTeamRows.map((row) => (
                  <tr key={row.salesperson_user_id} className="border-b last:border-0">
                    <td className="py-3">{row.salesperson_name}</td>
                    <td className="py-3 text-right">{row.customers_count}</td>
                    <td className="py-3 text-right">{row.orders_count}</td>
                    <td className="py-3 text-right">{formatOrderMoney(row.revenue, null, currency)}</td>
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
