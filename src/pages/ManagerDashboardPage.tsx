import { useEffect, useMemo, useState } from "react";
import { Users, ShoppingCart } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import { RetailFinancialKpiSection } from "@/components/RetailFinancialKpiSection";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import {
  useManagerSelectedSalespeopleTimeseries,
  useManagerTeamMemberOptions,
  useSalespersonFinancialBreakdown,
  useScopeFinancialBreakdown,
  useScopeOrderTimeseries,
  useSalespeopleScopedMetricsAndSeries,
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

  const { data: teamMemberOptions = [] } = useManagerTeamMemberOptions(user?.id, scopeKey);
  /**
   * Use the financial-breakdown RPC so the table can show original gross, current gross,
   * net ex VAT, VAT, and refunded/returned value per salesperson.
   */
  const { data: teamBreakdownRows = [], isLoading: loadingTeam } = useSalespersonFinancialBreakdown(
    `manager-${user?.id ?? "none"}-team-breakdown`,
    fromIso,
    toIso,
    user?.id ?? null,
    "manager",
    Boolean(user?.id),
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
  /**
   * Always fetch the manager's own assigned-customer metrics so we can render
   * a "self" row in the Direct Reports Performance table. `teamRows` (from
   * get_salesperson_performance_rows) intentionally excludes users that hold a
   * manager/supervisor role, so the manager would otherwise be invisible in
   * their own team breakdown. Reuses the existing per-salesperson RPC with the
   * manager's own user id.
   */
  const { data: selfMetrics } = useSalespeopleScopedMetricsAndSeries(
    user?.id ? [user.id] : [],
    fromIso,
    toIso,
    bucket,
    `${scopeKey}-self`,
    Boolean(user?.id),
  );

  const metrics = scopeMode === "team" ? allMetrics : scopedData;
  const series = scopeMode === "team" ? allSeries : (selectedSeries.length ? selectedSeries : scopedData?.series ?? []);
  const loadingMetrics = scopeMode === "team" ? loadingAllMetrics : loadingScopedData || loadingSelectedSeries;
  const loadingSeries = scopeMode === "team" ? loadingAllSeries : loadingSelectedSeries;

  type BreakdownRow = {
    salesperson_user_id: string;
    salesperson_name: string;
    customers_count: number;
    orders_total_count: number;
    original_gross_sales: number;
    current_gross_sales: number;
    net_sales_ex_vat: number;
    vat_collected: number;
    refunded_returned_value: number;
  };

  const teamRows = useMemo<BreakdownRow[]>(
    () =>
      teamBreakdownRows.map((row) => ({
        salesperson_user_id: row.salesperson_user_id,
        salesperson_name: row.salesperson_name,
        customers_count: Number(row.customers_count || 0),
        orders_total_count: Number(row.orders_total_count || 0),
        original_gross_sales: Number(row.original_gross_sales || 0),
        current_gross_sales: Number(row.current_gross_sales || 0),
        net_sales_ex_vat: Number(row.net_sales_ex_vat || 0),
        vat_collected: Number(row.vat_collected || 0),
        refunded_returned_value: Number(row.refunded_returned_value || 0),
      })),
    [teamBreakdownRows],
  );

  const selfRow = useMemo<BreakdownRow | null>(() => {
    if (!user?.id) return null;
    return {
      salesperson_user_id: user.id,
      salesperson_name: user.salesperson_name?.trim() || user.name || "Me",
      customers_count: Number(selfMetrics?.customers_count || 0),
      orders_total_count: Number(selfMetrics?.orders_total_count || selfMetrics?.orders_count || 0),
      original_gross_sales: Number(selfMetrics?.original_gross_sales || 0),
      current_gross_sales: Number(selfMetrics?.current_gross_sales || selfMetrics?.revenue || 0),
      net_sales_ex_vat: Number(selfMetrics?.net_sales_ex_vat || 0),
      vat_collected: Number(selfMetrics?.vat_collected || 0),
      refunded_returned_value: Number(selfMetrics?.refunded_returned_value || 0),
    };
  }, [user?.id, user?.name, user?.salesperson_name, selfMetrics]);

  /**
   * Direct Reports Performance rows BEFORE quick (top/bottom) filters.
   * - team: manager + direct reports (manager wants to be part of the team breakdown)
   * - mine: just the manager
   * - salesperson: only the chosen salesperson (or all reports when "all")
   */
  const baseRowsForScope = useMemo<BreakdownRow[]>(() => {
    if (scopeMode === "mine") return selfRow ? [selfRow] : [];
    if (scopeMode === "salesperson") {
      if (selectedSalespersonId === "all") return teamRows;
      return teamRows.filter((row) => row.salesperson_user_id === selectedSalespersonId);
    }
    return selfRow ? [selfRow, ...teamRows] : teamRows;
  }, [scopeMode, selectedSalespersonId, teamRows, selfRow]);

  const quickScopedIds = useMemo(() => {
    if (quickMemberFilter === "all") return null;
    const ranked = [...baseRowsForScope].sort(
      (a, b) => Number(b.current_gross_sales || 0) - Number(a.current_gross_sales || 0),
    );
    const sliced = quickMemberFilter === "top3" ? ranked.slice(0, 3) : ranked.slice(-3);
    return new Set(sliced.map((r) => r.salesperson_user_id));
  }, [baseRowsForScope, quickMemberFilter]);

  const filteredTeamRows = useMemo<BreakdownRow[]>(() => {
    if (!quickScopedIds) return baseRowsForScope;
    return baseRowsForScope.filter((row) => quickScopedIds.has(row.salesperson_user_id));
  }, [baseRowsForScope, quickScopedIds]);

  /**
   * Sum of the breakdown rows. We expose it as a Totals row so the manager can
   * compare against the KPI cards above and confirm the manager + team add up
   * (the KPI uses get_scope_financial_breakdown over the manager's full scope,
   * which already includes the manager via get_user_scope_user_ids; rows sum
   * may be slightly higher than the KPI when the same customer is assigned to
   * more than one salesperson, because the KPI deduplicates at the order level).
   */
  const breakdownTotals = useMemo(() => {
    return filteredTeamRows.reduce(
      (acc, row) => {
        acc.customers_count += Number(row.customers_count || 0);
        acc.orders_total_count += Number(row.orders_total_count || 0);
        acc.original_gross_sales += Number(row.original_gross_sales || 0);
        acc.current_gross_sales += Number(row.current_gross_sales || 0);
        acc.net_sales_ex_vat += Number(row.net_sales_ex_vat || 0);
        acc.vat_collected += Number(row.vat_collected || 0);
        acc.refunded_returned_value += Number(row.refunded_returned_value || 0);
        return acc;
      },
      {
        customers_count: 0,
        orders_total_count: 0,
        original_gross_sales: 0,
        current_gross_sales: 0,
        net_sales_ex_vat: 0,
        vat_collected: 0,
        refunded_returned_value: 0,
      },
    );
  }, [filteredTeamRows]);

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
            <p className="text-xs text-muted-foreground font-body">Selected scope current gross</p>
            <p className="text-xl font-heading font-bold">{formatOrderMoney(metrics?.current_gross_sales || 0, null, currency)}</p>
          </div>
          <div className="card-float p-4">
            <p className="text-xs text-muted-foreground font-body">Full team current gross</p>
            <p className="text-xl font-heading font-bold">{formatOrderMoney(allMetrics?.current_gross_sales || 0, null, currency)}</p>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <RetailFinancialKpiSection metrics={metrics} loading={loadingMetrics} currency={currency} delayBase={50} />
        <div className="grid grid-cols-1 sm:max-w-xs">
          <KpiCard title="Total Orders" value={loadingMetrics ? <Skeleton className="h-8 w-16 rounded-md" /> : String(metrics?.orders_total_count || 0)} icon={ShoppingCart} info="All in-scope orders across all financial statuses." delay={200} />
        </div>
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
              <BarChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  formatter={(v: number) => [formatOrderMoney(v, null, currency), "Current gross sales"]}
                />
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
                  <th className="text-right py-2.5 font-medium">Registered Customers</th>
                  <th className="text-right py-2.5 font-medium">Orders</th>
                  <th className="text-right py-2.5 font-medium">Original gross</th>
                  <th className="text-right py-2.5 font-medium">Current gross</th>
                  <th className="text-right py-2.5 font-medium">Net ex VAT</th>
                  <th className="text-right py-2.5 font-medium">VAT</th>
                  <th className="text-right py-2.5 font-medium">Refunded / returned</th>
                </tr>
              </thead>
              <tbody>
                {filteredTeamRows.map((row) => (
                  <tr key={row.salesperson_user_id} className="border-b last:border-0">
                    <td className="py-3">{row.salesperson_name}</td>
                    <td className="py-3 text-right">{row.customers_count}</td>
                    <td className="py-3 text-right">{row.orders_total_count}</td>
                    <td className="py-3 text-right">{formatOrderMoney(row.original_gross_sales, null, currency)}</td>
                    <td className="py-3 text-right">{formatOrderMoney(row.current_gross_sales, null, currency)}</td>
                    <td className="py-3 text-right">{formatOrderMoney(row.net_sales_ex_vat, null, currency)}</td>
                    <td className="py-3 text-right">{formatOrderMoney(row.vat_collected, null, currency)}</td>
                    <td className="py-3 text-right">{formatOrderMoney(row.refunded_returned_value, null, currency)}</td>
                  </tr>
                ))}
                {filteredTeamRows.length > 1 && (
                  <tr className="border-t-2 border-foreground/20 font-semibold bg-muted/30">
                    <td className="py-3">Total</td>
                    <td className="py-3 text-right">{breakdownTotals.customers_count}</td>
                    <td className="py-3 text-right">{breakdownTotals.orders_total_count}</td>
                    <td className="py-3 text-right">{formatOrderMoney(breakdownTotals.original_gross_sales, null, currency)}</td>
                    <td className="py-3 text-right">{formatOrderMoney(breakdownTotals.current_gross_sales, null, currency)}</td>
                    <td className="py-3 text-right">{formatOrderMoney(breakdownTotals.net_sales_ex_vat, null, currency)}</td>
                    <td className="py-3 text-right">{formatOrderMoney(breakdownTotals.vat_collected, null, currency)}</td>
                    <td className="py-3 text-right">{formatOrderMoney(breakdownTotals.refunded_returned_value, null, currency)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
