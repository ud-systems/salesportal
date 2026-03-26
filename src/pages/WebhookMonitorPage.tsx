import { useEffect, useState } from "react";
import { useWebhookEvents } from "@/hooks/use-shopify-data";
import { HeaderSkeleton, TableSkeleton } from "@/components/PageSkeletons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Filter } from "lucide-react";
import { BottomSheet } from "@/components/BottomSheet";
import { Button } from "@/components/ui/button";

const TOPICS = [
  "all",
  "customers/create",
  "customers/update",
  "orders/create",
  "orders/updated",
  "products/create",
  "products/update",
];

function statusPill(status: string) {
  if (status === "success") return "bg-primary/10 text-primary";
  if (status === "ignored") return "bg-muted text-muted-foreground";
  if (status === "error") return "bg-destructive/10 text-destructive";
  return "bg-info/10 text-info";
}

export default function WebhookMonitorPage() {
  const [isMobile, setIsMobile] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [topic, setTopic] = useState("all");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    const update = () => setIsMobile(window.matchMedia("(max-width: 767px)").matches);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const { data: rows, isLoading } = useWebhookEvents({ fromDate, toDate, sortDir, topic });

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Webhook Monitor</h1>
          <p className="text-muted-foreground font-body text-sm mt-1">Realtime Shopify webhook delivery and processing status</p>
        </div>
        <button onClick={() => setFilterOpen(true)} className="tap-scale h-10 text-muted-foreground md:hidden" aria-label="Open filters">
          <Filter className="h-5 w-5" />
        </button>
      </div>

      <div className="hidden md:grid grid-cols-1 md:grid-cols-4 gap-2">
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <Select value={topic} onValueChange={setTopic}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Topic" />
          </SelectTrigger>
          <SelectContent>
            {TOPICS.map((t) => <SelectItem key={t} value={t}>{t === "all" ? "All Topics" : t}</SelectItem>)}
          </SelectContent>
        </Select>
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
        title="Filter Webhook Events"
        footer={<Button className="w-full rounded-xl h-11 font-body tap-scale" onClick={() => setFilterOpen(false)}>Apply Filters</Button>}
      >
        <div className="space-y-3">
          <p className="text-sm font-medium font-body text-foreground">Date range</p>
          <div className="grid grid-cols-1 gap-2">
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Topic</p>
          <Select value={topic} onValueChange={setTopic}>
            <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body w-full">
              <SelectValue placeholder="Topic" />
            </SelectTrigger>
            <SelectContent>
              {TOPICS.map((t) => <SelectItem key={t} value={t}>{t === "all" ? "All Topics" : t}</SelectItem>)}
            </SelectContent>
          </Select>
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
        <div className="space-y-5"><HeaderSkeleton /><TableSkeleton rows={8} cols={6} /></div>
      ) : !rows?.length ? (
        <div className="card-float p-10 text-center">
          <p className="text-muted-foreground font-body">No webhook events found for current filters.</p>
        </div>
      ) : (
        <>
          <div className="hidden md:block card-float p-5 overflow-x-auto">
            <table className="w-full text-sm font-body">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-2.5 font-medium">Status</th>
                  <th className="text-left py-2.5 font-medium">Topic</th>
                  <th className="text-left py-2.5 font-medium">Shop</th>
                  <th className="text-left py-2.5 font-medium">Received</th>
                  <th className="text-left py-2.5 font-medium">Processed</th>
                  <th className="text-left py-2.5 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
                    <td className="py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusPill(row.status)}`}>{row.status}</span>
                    </td>
                    <td className="py-3 text-foreground">{row.topic}</td>
                    <td className="py-3 text-muted-foreground">{row.shop_domain}</td>
                    <td className="py-3 text-muted-foreground">{new Date(row.received_at).toLocaleString()}</td>
                    <td className="py-3 text-muted-foreground">{row.processed_at ? new Date(row.processed_at).toLocaleString() : "—"}</td>
                    <td className="py-3 text-destructive text-xs max-w-[260px] truncate">{row.error_message || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="md:hidden space-y-3">
            {rows.map((row, i) => (
              <div key={row.id} className="card-float p-4 opacity-0 animate-fade-in" style={{ animationDelay: `${80 + i * 40}ms` }}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusPill(row.status)}`}>{row.status}</span>
                  <span className="text-xs text-muted-foreground font-body">{new Date(row.received_at).toLocaleTimeString()}</span>
                </div>
                <p className="text-sm font-medium text-foreground break-all">{row.topic}</p>
                <p className="text-xs text-muted-foreground font-body mt-1 break-all">{row.shop_domain}</p>
                {row.error_message && <p className="text-xs text-destructive font-body mt-2">{row.error_message}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
