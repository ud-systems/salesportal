import { useState, useMemo, useEffect } from "react";
import { useInventoryLocations, useVariantsPaginated } from "@/hooks/use-shopify-data";
import { Search, AlertTriangle, MapPin, Warehouse } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/BottomSheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { HeaderSkeleton, SearchRowSkeleton, TableSkeleton } from "@/components/PageSkeletons";

export default function InventoryPage() {
  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [isMobile, setIsMobile] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sortBy, setSortBy] = useState<"stock" | "updated_at" | "price" | "sku">("stock");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const pageSize = isMobile ? 10 : 15;
  const { data: locationsData } = useInventoryLocations();
  const locations = locationsData?.filter(Boolean) ?? ["all"];
  const { data, isLoading } = useVariantsPaginated({ page, pageSize, search, locationFilter, fromDate, toDate, sortBy, sortDir });
  const variants = data?.data ?? [];
  const totalCount = data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  useEffect(() => {
    const update = () => setIsMobile(window.matchMedia("(max-width: 767px)").matches);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    setPage(1);
  }, [search, locationFilter, pageSize, fromDate, toDate, sortBy, sortDir]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const filtered = variants;

  // Group by product+variant title
  const grouped = useMemo(() => {
    const map: Record<string, { items: any[]; totalQty: number; sku: string; product: string; variant: string }> = {};
    for (const v of filtered) {
      const vAny = v as any;
      const product = vAny.shopify_products?.title || "Unknown";
      const variant = vAny.title || "Default";
      const key = `${product} — ${variant}`;
      if (!map[key]) map[key] = { items: [], totalQty: 0, sku: vAny.sku || "", product, variant };
      map[key].items.push(vAny);
      map[key].totalQty += (vAny.stock || 0);
    }
    return map;
  }, [filtered]);

  if (isLoading) return <div className="space-y-5 max-w-[1200px]"><HeaderSkeleton /><SearchRowSkeleton /><TableSkeleton rows={6} cols={4} /></div>;

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Inventory</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">Stock levels across locations</p>
      </div>

      <div className="flex gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "50ms" }}>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search products or SKU..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 rounded-xl h-10 font-body border-border" />
        </div>
        <button onClick={() => setFilterOpen(true)} className="h-10 px-4 rounded-xl border bg-card font-body text-sm text-muted-foreground hover:bg-muted transition-colors tap-scale lg:hidden">Filter</button>
      </div>
      <div className="hidden lg:grid grid-cols-1 md:grid-cols-4 gap-2">
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <Select value={sortBy} onValueChange={(value: "stock" | "updated_at" | "price" | "sku") => setSortBy(value)}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stock">Sort: Stock</SelectItem>
            <SelectItem value="updated_at">Sort: Updated Date</SelectItem>
            <SelectItem value="price">Sort: Price</SelectItem>
            <SelectItem value="sku">Sort: SKU</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortDir} onValueChange={(value: "asc" | "desc") => setSortDir(value)}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Direction" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="asc">Ascending</SelectItem>
            <SelectItem value="desc">Descending</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="hidden lg:flex gap-2 overflow-x-auto pb-1 opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
        <button onClick={() => setLocationFilter("all")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale flex items-center gap-1.5 ${locationFilter === "all" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>
          <Warehouse className="h-3 w-3" /> All Locations
        </button>
        {locations.filter((loc) => loc !== "all").map(loc => (
          <button key={loc} onClick={() => setLocationFilter(loc)} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale flex items-center gap-1.5 ${locationFilter === loc ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>
            <MapPin className="h-3 w-3" /> {loc}
          </button>
        ))}
      </div>
      <BottomSheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Filter Inventory" footer={<Button className="w-full rounded-xl h-11 font-body tap-scale" onClick={() => setFilterOpen(false)}>Apply Filters</Button>}>
        <div className="space-y-3">
          <p className="text-sm font-medium font-body text-foreground">Date range</p>
          <div className="grid grid-cols-1 gap-2">
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Sort</p>
          <div className="grid grid-cols-1 gap-2">
            <Select value={sortBy} onValueChange={(value: "stock" | "updated_at" | "price" | "sku") => setSortBy(value)}>
              <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stock">Sort: Stock</SelectItem>
                <SelectItem value="updated_at">Sort: Updated Date</SelectItem>
                <SelectItem value="price">Sort: Price</SelectItem>
                <SelectItem value="sku">Sort: SKU</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortDir} onValueChange={(value: "asc" | "desc") => setSortDir(value)}>
              <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
                <SelectValue placeholder="Direction" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Location</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setLocationFilter("all")} className={`px-4 py-2 rounded-xl text-sm font-body transition-colors tap-scale ${locationFilter === "all" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
              All Locations
            </button>
            {locations.filter((loc) => loc !== "all").map((loc) => (
              <button key={`mobile-${loc}`} onClick={() => setLocationFilter(loc)} className={`px-4 py-2 rounded-xl text-sm font-body transition-colors tap-scale ${locationFilter === loc ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {loc}
              </button>
            ))}
          </div>
        </div>
      </BottomSheet>

      {Object.keys(grouped).length === 0 ? (
        <div className="card-float p-10 text-center opacity-0 animate-fade-in"><p className="text-muted-foreground font-body">No inventory data. Run a Shopify sync first.</p></div>
      ) : (
        <>
          <div className="space-y-3">
            {Object.entries(grouped).map(([key, group], i) => (
              <div key={key} className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: `${100 + i * 60}ms` }}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-heading font-semibold text-foreground text-sm">{group.product}</h3>
                    <p className="text-xs text-muted-foreground font-body">{group.variant}{group.sku ? ` · SKU: ${group.sku}` : ""}</p>
                  </div>
                  <span className={`text-sm font-heading font-bold flex items-center gap-1 ${group.totalQty <= 10 ? "text-destructive" : group.totalQty <= 50 ? "text-warning" : "text-primary"}`}>
                    {group.totalQty <= 10 && <AlertTriangle className="h-3.5 w-3.5" />}
                    {group.totalQty} total
                  </span>
                </div>
                <div className="space-y-1.5">
                  {group.items.map((item: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between p-2 rounded-lg bg-muted/50 text-sm font-body">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <MapPin className="h-3 w-3" /> {item.inventory_location || "Default"}
                      </span>
                      <span className={`font-medium ${(item.stock || 0) <= 5 ? "text-destructive" : "text-foreground"}`}>
                        {item.stock || 0} units
                      </span>
                    </div>
                  ))}
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
    </div>
  );
}
