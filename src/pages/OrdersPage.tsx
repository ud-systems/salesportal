import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useOrderItems, useOrdersPaginated } from "@/hooks/use-shopify-data";
import { StatusBadge } from "@/components/StatusBadge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/BottomSheet";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { useSearchParams } from "react-router-dom";

export default function OrdersPage() {
  const [searchParams] = useSearchParams();
  const initialFulfillment = (() => {
    const val = searchParams.get("fulfillment");
    if (val && ["all", "fulfilled", "partial", "unfulfilled", "on_hold"].includes(val)) return val;
    return "all";
  })();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [fulfillmentFilter, setFulfillmentFilter] = useState(initialFulfillment);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null);
  const [page, setPage] = useState(1);
  const [isMobile, setIsMobile] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sortBy, setSortBy] = useState<"shopify_created_at" | "processed_at" | "total" | "order_number">("shopify_created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const pageSize = isMobile ? 10 : 15;
  const { data, isLoading } = useOrdersPaginated({
    page, pageSize, search, statusFilter, fulfillmentFilter, fromDate, toDate, sortBy, sortDir,
  });
  const orders = data?.data ?? [];
  const totalCount = data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const { data: selectedItems } = useOrderItems(selectedOrder?.id);

  useEffect(() => {
    const update = () => setIsMobile(window.matchMedia("(max-width: 767px)").matches);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, fulfillmentFilter, pageSize, fromDate, toDate, sortBy, sortDir]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const statuses = ["all", "paid", "pending", "refunded", "partially_paid"];
  const fulfillmentStatuses = ["all", "fulfilled", "partial", "unfulfilled", "on_hold"];

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Orders</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">{totalCount} orders</p>
      </div>

      <div className="flex gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "50ms" }}>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search orders..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 rounded-xl h-10 font-body border-border" />
        </div>
        <button onClick={() => setFilterOpen(true)} className="h-10 px-4 rounded-xl border bg-card font-body text-sm text-muted-foreground hover:bg-muted transition-colors tap-scale lg:hidden">Filter</button>
      </div>
      <div className="hidden lg:grid grid-cols-1 md:grid-cols-4 gap-2">
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <Select value={sortBy} onValueChange={(value: "shopify_created_at" | "processed_at" | "total" | "order_number") => setSortBy(value)}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="shopify_created_at">Sort: Created Date</SelectItem>
            <SelectItem value="processed_at">Sort: Processed Date</SelectItem>
            <SelectItem value="total">Sort: Amount</SelectItem>
            <SelectItem value="order_number">Sort: Order Number</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortDir} onValueChange={(value: "asc" | "desc") => setSortDir(value)}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Direction" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="desc">Descending</SelectItem>
            <SelectItem value="asc">Ascending</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="hidden lg:flex gap-2 overflow-x-auto pb-1 opacity-0 animate-fade-in" style={{ animationDelay: "70ms" }}>
        {statuses.map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>
            {s === "all" ? "All" : s === "partially_paid" ? "Partial" : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        {fulfillmentStatuses.map((s) => (
          <button key={`f-${s}`} onClick={() => setFulfillmentFilter(s)} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${fulfillmentFilter === s ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>
            {s === "all" ? "All Fulfillment" : s.replace("_", " ")}
          </button>
        ))}
      </div>

      <BottomSheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Filter Orders" footer={<Button className="w-full rounded-xl h-11 font-body tap-scale" onClick={() => setFilterOpen(false)}>Apply Filters</Button>}>
        <div className="space-y-3">
          <p className="text-sm font-medium font-body text-foreground">Date range</p>
          <div className="grid grid-cols-1 gap-2">
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Sort</p>
          <div className="grid grid-cols-1 gap-2">
            <Select value={sortBy} onValueChange={(value: "shopify_created_at" | "processed_at" | "total" | "order_number") => setSortBy(value)}>
              <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shopify_created_at">Sort: Created Date</SelectItem>
                <SelectItem value="processed_at">Sort: Processed Date</SelectItem>
                <SelectItem value="total">Sort: Amount</SelectItem>
                <SelectItem value="order_number">Sort: Order Number</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortDir} onValueChange={(value: "asc" | "desc") => setSortDir(value)}>
              <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
                <SelectValue placeholder="Direction" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">Descending</SelectItem>
                <SelectItem value="asc">Ascending</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-sm font-medium font-body text-foreground">Payment Status</p>
          <div className="flex flex-wrap gap-2">
            {statuses.map(s => (
              <button key={s} onClick={() => setStatusFilter(s)} className={`px-4 py-2 rounded-xl text-sm font-body transition-colors tap-scale ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {s === "all" ? "All" : s === "partially_paid" ? "Partial" : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Fulfillment Status</p>
          <div className="flex flex-wrap gap-2">
            {fulfillmentStatuses.map((s) => (
              <button key={`mf-${s}`} onClick={() => setFulfillmentFilter(s)} className={`px-4 py-2 rounded-xl text-sm font-body transition-colors tap-scale ${fulfillmentFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {s === "all" ? "All" : s.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>
      </BottomSheet>

      {isLoading ? (
        <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
          <div className="space-y-3">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        </div>
      ) : orders.length === 0 ? (
        <div className="card-float p-10 text-center opacity-0 animate-fade-in"><p className="text-muted-foreground font-body">No orders found. Run a Shopify sync first.</p></div>
      ) : (
        <>
          <div className="hidden md:block card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-body">
                <thead><tr className="border-b text-muted-foreground"><th className="text-left py-2.5 font-medium">Order #</th><th className="text-left py-2.5 font-medium">Customer</th><th className="text-right py-2.5 font-medium">Amount</th><th className="text-left py-2.5 font-medium">Payment</th><th className="text-left py-2.5 font-medium">Fulfillment</th><th className="text-left py-2.5 font-medium">Date</th></tr></thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} onClick={() => setSelectedOrder(o)} className="border-b last:border-0 hover:bg-muted/50 transition-colors cursor-pointer">
                      <td className="py-3 font-medium text-foreground">{o.order_number || o.shopify_order_id}</td>
                      <td className="py-3 text-muted-foreground">{o.customer_name}</td>
                      <td className="py-3 text-right font-medium text-foreground">${Number(o.total).toLocaleString()}</td>
                      <td className="py-3"><StatusBadge status={(o.financial_status || "pending") as any} /></td>
                      <td className="py-3"><StatusBadge status={(o.fulfillment_status || "unfulfilled") as any} /></td>
                      <td className="py-3 text-muted-foreground">{o.shopify_created_at ? new Date(o.shopify_created_at).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="md:hidden space-y-3">
            {orders.map((o, i) => (
              <div key={o.id} className="card-float p-4 tap-scale opacity-0 animate-fade-in" style={{ animationDelay: `${100 + i * 50}ms` }}>
                <div className="flex items-start justify-between mb-2">
                  <div><p className="font-medium text-foreground text-sm">{o.order_number || o.shopify_order_id}</p><p className="text-xs text-muted-foreground mt-0.5">{o.customer_name}</p></div>
                  <p className="font-heading font-bold text-foreground">${Number(o.total).toLocaleString()}</p>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <StatusBadge status={(o.financial_status || "pending") as any} />
                  <StatusBadge status={(o.fulfillment_status || "unfulfilled") as any} />
                  <span className="text-xs text-muted-foreground ml-auto font-body">{o.shopify_created_at ? new Date(o.shopify_created_at).toLocaleDateString() : ""}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="card-float p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground font-body px-2">
              <span>Showing {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, totalCount)} of {totalCount}</span>
              <span>Page {page} / {totalPages}</span>
            </div>
            <Pagination className="mt-2">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious href="#" onClick={(e) => { e.preventDefault(); if (page > 1) setPage(page - 1); }} className={page <= 1 ? "pointer-events-none opacity-50" : ""} />
                </PaginationItem>
                {Array.from({ length: Math.min(5, totalPages) }).map((_, i) => {
                  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
                  const pageNum = start + i;
                  if (pageNum > totalPages) return null;
                  return (
                    <PaginationItem key={pageNum}>
                      <PaginationLink href="#" isActive={pageNum === page} onClick={(e) => { e.preventDefault(); setPage(pageNum); }}>
                        {pageNum}
                      </PaginationLink>
                    </PaginationItem>
                  );
                })}
                <PaginationItem>
                  <PaginationNext href="#" onClick={(e) => { e.preventDefault(); if (page < totalPages) setPage(page + 1); }} className={page >= totalPages ? "pointer-events-none opacity-50" : ""} />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </>
      )}

      <Sheet open={!!selectedOrder} onOpenChange={(open) => !open && setSelectedOrder(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Order Details</SheetTitle>
          </SheetHeader>
          {selectedOrder && (
            <div className="space-y-4 mt-4 font-body text-sm">
              <div className="rounded-xl border bg-card p-4">
                <p className="text-lg font-semibold text-foreground">{selectedOrder.order_number || selectedOrder.shopify_order_id}</p>
                <p className="text-muted-foreground">{selectedOrder.customer_name || "Unknown customer"} · {selectedOrder.email || "No email"}</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">Total</p><p className="font-semibold">${Number(selectedOrder.total || 0).toLocaleString()}</p></div>
                <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">Subtotal</p><p className="font-semibold">${Number(selectedOrder.subtotal || 0).toLocaleString()}</p></div>
                <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">Tax</p><p className="font-semibold">${Number(selectedOrder.total_tax || 0).toLocaleString()}</p></div>
              </div>
              <div className="rounded-xl border p-4 space-y-2">
                <p><span className="text-muted-foreground">Currency:</span> {selectedOrder.currency_code || "—"}</p>
                <p><span className="text-muted-foreground">Payment:</span> {selectedOrder.financial_status || "—"}</p>
                <p><span className="text-muted-foreground">Fulfillment:</span> {selectedOrder.fulfillment_status || "—"}</p>
                <p><span className="text-muted-foreground">Processed:</span> {selectedOrder.processed_at ? new Date(selectedOrder.processed_at).toLocaleString() : "—"}</p>
                <p><span className="text-muted-foreground">Tags:</span> {selectedOrder.tags || "—"}</p>
                <p><span className="text-muted-foreground">Note:</span> {selectedOrder.order_note || "—"}</p>
              </div>
              <div className="rounded-xl border p-4 space-y-2">
                <p className="font-semibold text-foreground">Line Items</p>
                {!selectedItems?.length ? (
                  <p className="text-muted-foreground">No line items found.</p>
                ) : (
                  selectedItems.map((item: any) => (
                    <div key={item.id} className="flex items-center justify-between text-xs border-b last:border-0 pb-2 last:pb-0">
                      <div className="pr-2">
                        <p className="text-foreground font-medium">{item.product || "Item"}</p>
                        <p className="text-muted-foreground">{item.variant || "Default"} {item.sku ? `· SKU ${item.sku}` : ""}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-foreground">x{item.quantity || 0}</p>
                        <p className="text-muted-foreground">${Number(item.price || 0).toLocaleString()}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="flex justify-end">
                <SheetClose asChild>
                  <Button variant="outline" className="rounded-xl">Close</Button>
                </SheetClose>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
