import {
  useSyncLogs,
  triggerSync,
  triggerSyncUntilUpToDate,
  type ShopifySyncModule,
} from "@/hooks/use-shopify-data";
import { RefreshCw, CheckCircle, XCircle, Loader2, Info, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { BottomSheet } from "@/components/BottomSheet";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function useNowTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function formatRunningSeconds(startedAt: string, nowMs: number) {
  const sec = Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function syncTypeLabel(syncType: string) {
  if (syncType === "products") return "Products & inventory (variants)";
  if (syncType === "collections") return "Collections";
  if (syncType === "purchase_orders") return "Purchase Orders";
  return syncType;
}

export default function SyncLogsPage() {
  const [syncing, setSyncing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedModule, setSelectedModule] = useState<"all" | ShopifySyncModule>("all");
  const { data: logs, isLoading } = useSyncLogs({ fromDate, toDate, sortDir, forcePolling: syncing });
  const queryClient = useQueryClient();
  const hasRunning = (logs ?? []).some((l) => l.status === "running");
  const nowTick = useNowTick(hasRunning || syncing);

  useEffect(() => {
    const update = () => setIsMobile(window.matchMedia("(max-width: 767px)").matches);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await triggerSync();
      const r = result?.results;
      const notes = [r?.customers?.note, r?.orders?.note, r?.products?.note, r?.collections?.note, r?.purchase_orders?.note].filter(Boolean).join(" ");
      toast.success("Sync finished", {
        description: `Customers: ${r?.customers?.synced ?? 0} · Orders: ${r?.orders?.synced ?? 0} · Products: ${r?.products?.synced ?? 0} · Collections: ${r?.collections?.synced ?? 0} · POs: ${r?.purchase_orders?.synced ?? 0}${notes ? ` · ${notes}` : ""}`,
      });
      // Refresh all data
      queryClient.invalidateQueries();
    } catch (err) {
      toast.error("Sync failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleAutoSync = async () => {
    setSyncing(true);
    try {
      const out = await triggerSyncUntilUpToDate(20);
      const r = out?.result?.results;
      const notes = [r?.customers?.note, r?.orders?.note, r?.products?.note, r?.collections?.note, r?.purchase_orders?.note].filter(Boolean).join(" ");
      toast.success(out.completed ? "Auto-sync up to date" : "Auto-sync paused at max runs", {
        description: `Runs: ${out.runs} · Customers: ${r?.customers?.synced ?? 0} · Orders: ${r?.orders?.synced ?? 0} · Products: ${r?.products?.synced ?? 0} · Collections: ${r?.collections?.synced ?? 0} · POs: ${r?.purchase_orders?.synced ?? 0}${notes ? ` · ${notes}` : ""}`,
      });
      queryClient.invalidateQueries();
    } catch (err) {
      toast.error("Auto-sync failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSyncing(false);
    }
  };
  const moduleLabel = (module: ShopifySyncModule) => {
    if (module === "purchase_orders") return "Purchase Orders";
    return module.charAt(0).toUpperCase() + module.slice(1).replace("_", " ");
  };

  const handleAutoSyncModule = async (module: ShopifySyncModule) => {
    setSyncing(true);
    try {
      const out = await triggerSyncUntilUpToDate(20, module);
      const r = out?.result?.results?.[module];
      const note = r?.note ? ` · ${r.note}` : "";
      toast.success(out.completed ? `${moduleLabel(module)} up to date` : `${moduleLabel(module)} auto-sync paused at max runs`, {
        description: `Runs: ${out.runs} · Synced: ${r?.synced ?? 0}${note}`,
      });
      queryClient.invalidateQueries();
    } catch (err) {
      toast.error(`${moduleLabel(module)} auto-sync failed`, {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSyncing(false);
    }
  };
  const handleAutoSyncSelection = async () => {
    if (selectedModule === "all") {
      await handleAutoSync();
      return;
    }
    await handleAutoSyncModule(selectedModule);
  };

  /** Clears the customers incremental checkpoint once, then auto-runs until the full catalog is processed (same as multiple “Sync Selected” runs). */
  const handleFullCustomerResync = async () => {
    setSyncing(true);
    try {
      const out = await triggerSyncUntilUpToDate(20, "customers", { resetCustomerCheckpointFirstRun: true });
      const r = out?.result?.results?.customers;
      const note = r?.note ? ` · ${r.note}` : "";
      toast.success(out.completed ? "Customer full resync finished" : "Customer resync paused at max runs", {
        description: `Runs: ${out.runs} · Synced: ${r?.synced ?? 0}${note}`,
      });
      queryClient.invalidateQueries();
    } catch (err) {
      toast.error("Customer full resync failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSyncing(false);
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "success": return <CheckCircle className="h-4 w-4 text-primary" />;
      case "error": return <XCircle className="h-4 w-4 text-destructive" />;
      case "running": return <Loader2 className="h-4 w-4 text-info animate-spin" />;
      default: return null;
    }
  };

  return (
    <div className="w-full space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Sync Logs</h1>
          <p className="text-muted-foreground font-body text-sm mt-1">Shopify data sync history</p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Button onClick={handleSync} disabled={syncing} variant="outline" className="rounded-xl tap-scale font-body gap-2 flex-1 sm:flex-none">
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync Once"}
          </Button>
          <Button onClick={handleAutoSync} disabled={syncing} className="rounded-xl tap-scale font-body gap-2 flex-1 sm:flex-none">
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Auto-sync running..." : isMobile ? "Auto Sync All" : "Auto Sync All Until Up To Date"}
          </Button>
          <button onClick={() => setFilterOpen(true)} className="tap-scale h-10 text-muted-foreground sm:hidden" aria-label="Open filters">
            <Filter className="h-5 w-5" />
          </button>
          <button onClick={() => setInfoOpen(true)} className="tap-scale ml-auto sm:ml-0 h-10 text-primary" aria-label="Sync information">
            <Info className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-2">
          <Select value={selectedModule} onValueChange={(value: "all" | ShopifySyncModule) => setSelectedModule(value)}>
            <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
              <SelectValue placeholder="Select auto sync target" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Modules</SelectItem>
              <SelectItem value="customers">Customers</SelectItem>
              <SelectItem value="orders">Orders</SelectItem>
              <SelectItem value="products">Products</SelectItem>
              <SelectItem value="collections">Collections</SelectItem>
              <SelectItem value="purchase_orders">Purchase Orders</SelectItem>
            </SelectContent>
          </Select>
          <Button disabled={syncing} variant="outline" className="rounded-xl tap-scale font-body" onClick={handleAutoSyncSelection}>
            {syncing
              ? "Sync in progress..."
              : selectedModule === "all"
                ? "Auto Sync Selected (All)"
                : `Auto Sync Selected (${moduleLabel(selectedModule)})`}
          </Button>
        </div>
        {selectedModule === "customers" && (
          <Button
            disabled={syncing}
            variant="secondary"
            className="rounded-xl tap-scale font-body w-full sm:w-auto sm:self-start"
            onClick={handleFullCustomerResync}
          >
            {syncing ? "…" : "Full customer resync (reset incremental window)"}
          </Button>
        )}
      </div>

      {isMobile ? (
        <BottomSheet open={infoOpen} onClose={() => setInfoOpen(false)} title="Sync information">
          <div className="space-y-2 text-sm text-muted-foreground font-body">
            <p>
              Each run does <strong className="text-foreground">Customers</strong> → <strong className="text-foreground">Orders</strong> →{" "}
              <strong className="text-foreground">Products</strong> (variant stock is your inventory). If orders hang, products will not start until orders finish.
            </p>
            <p>
              Rows stuck on <span className="text-info">spinning</span> for more than ~30 minutes are auto-marked failed on the next sync. While a row shows running, this page refreshes every few seconds.
            </p>
            <p>
              <strong className="text-foreground">Customers</strong> sync skips everyone whose Shopify <code className="text-xs">updatedAt</code> is older than your last completed customer run (incremental). If you see “Synced: 0” but need to refresh metafields or assignments, select Customers and use{" "}
              <strong className="text-foreground">Full customer resync</strong>, or in Supabase SQL run:{" "}
              <code className="text-xs break-all">update sync_checkpoints set last_completed_at = null, cursor = null where sync_type = &apos;customers&apos;;</code>
            </p>
          </div>
        </BottomSheet>
      ) : (
        <Sheet open={infoOpen} onOpenChange={setInfoOpen}>
          <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Sync information</SheetTitle>
            </SheetHeader>
            <div className="space-y-2 text-sm text-muted-foreground font-body mt-4">
              <p>
                Each run does <strong className="text-foreground">Customers</strong> → <strong className="text-foreground">Orders</strong> →{" "}
                <strong className="text-foreground">Products</strong> (variant stock is your inventory). If orders hang, products will not start until orders finish.
              </p>
              <p>
                Rows stuck on <span className="text-info">spinning</span> for more than ~30 minutes are auto-marked failed on the next sync. While a row shows running, this page refreshes every few seconds.
              </p>
              <p>
                <strong className="text-foreground">Customers</strong> sync skips everyone whose Shopify <code className="text-xs">updatedAt</code> is older than your last completed customer run (incremental). If you see “Synced: 0” but need to refresh metafields or assignments, select Customers and use{" "}
                <strong className="text-foreground">Full customer resync</strong>, or in Supabase SQL run:{" "}
                <code className="text-xs break-all">update sync_checkpoints set last_completed_at = null, cursor = null where sync_type = &apos;customers&apos;;</code>
              </p>
            </div>
          </SheetContent>
        </Sheet>
      )}
      <div className="hidden md:grid grid-cols-1 md:grid-cols-3 gap-2">
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <Select value={sortDir} onValueChange={(value: "asc" | "desc") => setSortDir(value)}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Sort order" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="desc">Newest First</SelectItem>
            <SelectItem value="asc">Oldest First</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <BottomSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        title="Filter Sync Logs"
        footer={<Button className="w-full rounded-xl h-11 font-body tap-scale" onClick={() => setFilterOpen(false)}>Apply Filters</Button>}
      >
        <div className="space-y-3">
          <p className="text-sm font-medium font-body text-foreground">Date range</p>
          <div className="grid grid-cols-1 gap-2">
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Order</p>
          <Select value={sortDir} onValueChange={(value: "asc" | "desc") => setSortDir(value)}>
            <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body w-full">
              <SelectValue placeholder="Sort order" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">Newest First</SelectItem>
              <SelectItem value="asc">Oldest First</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </BottomSheet>

      {isLoading ? (
        <div className="card-float p-5 space-y-3">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : !logs?.length ? (
        <div className="card-float p-10 text-center opacity-0 animate-fade-in">
          <p className="text-muted-foreground font-body">No sync logs yet. Click "Sync Now" to pull data from Shopify.</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
            <table className="w-full text-sm font-body">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-2.5 font-medium">Status</th>
                  <th className="text-left py-2.5 font-medium">Type</th>
                  <th className="text-right py-2.5 font-medium">Records</th>
                  <th className="text-left py-2.5 font-medium">Started</th>
                  <th className="text-left py-2.5 font-medium">Duration</th>
                  <th className="text-left py-2.5 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => {
                  const records = log.records_synced ?? 0;
                  const start = new Date(log.started_at);
                  const end = log.completed_at ? new Date(log.completed_at) : null;
                  const duration =
                    log.status === "running"
                      ? `${formatRunningSeconds(log.started_at, nowTick)} …`
                      : end
                        ? `${((end.getTime() - start.getTime()) / 1000).toFixed(1)}s`
                        : "—";
                  return (
                    <tr key={log.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                      <td className="py-3">{statusIcon(log.status)}</td>
                      <td className="py-3 capitalize text-foreground font-medium">{syncTypeLabel(log.sync_type)}</td>
                      <td className="py-3 text-right text-foreground">{records}</td>
                      <td className="py-3 text-muted-foreground">{new Date(log.started_at).toLocaleString()}</td>
                      <td className="py-3 text-muted-foreground">{duration}</td>
                      <td className="py-3 text-destructive text-xs max-w-[200px] truncate">{log.error_message || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {logs.map((log, i) => {
              const records = log.records_synced ?? 0;
              const start = new Date(log.started_at);
              const end = log.completed_at ? new Date(log.completed_at) : null;
              const duration =
                log.status === "running"
                  ? `${formatRunningSeconds(log.started_at, nowTick)} …`
                  : end
                    ? `${((end.getTime() - start.getTime()) / 1000).toFixed(1)}s`
                    : "—";
              return (
                <div key={log.id} className="card-float p-4 opacity-0 animate-fade-in" style={{ animationDelay: `${100 + i * 50}ms` }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {statusIcon(log.status)}
                      <span className="font-medium text-foreground text-sm capitalize font-body">{syncTypeLabel(log.sync_type)}</span>
                    </div>
                    <span className="text-xs text-muted-foreground font-body">{records} records · {duration}</span>
                  </div>
                  <p className="text-xs text-muted-foreground font-body">{new Date(log.started_at).toLocaleString()}</p>
                  {log.error_message && (
                    <p className="text-xs text-destructive font-body mt-1">{log.error_message}</p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
