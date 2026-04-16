import { useProductStatuses, useProductsPaginated } from "@/hooks/use-shopify-data";
import { Package, AlertTriangle, Search, ChevronDown, ChevronRight, ImageIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { BottomSheet } from "@/components/BottomSheet";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatOrderMoney } from "@/lib/format";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";

export default function ProductsPage() {
  const { data: storeCurrency = "GBP" } = useShopDisplayCurrency();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(1);
  const [isMobile, setIsMobile] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sortBy, setSortBy] = useState<"title" | "updated_at" | "created_at" | "vendor">("title");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const pageSize = isMobile ? 10 : 15;
  const { data: statusesData } = useProductStatuses();
  const statuses = statusesData ?? ["all"];
  const { data, isLoading } = useProductsPaginated({ page, pageSize, search, statusFilter, fromDate, toDate, sortBy, sortDir });
  const products = data?.data ?? [];
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
  }, [search, statusFilter, stockFilter, pageSize, fromDate, toDate, sortBy, sortDir]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const filtered = (products || []).filter((p: any) => {
    const totalStock = (p.shopify_variants || []).reduce((sum: number, v: any) => sum + Number(v.stock || 0), 0);
    const matchesStock = stockFilter === "all" ||
      (stockFilter === "low" ? totalStock <= 10 : stockFilter === "out" ? totalStock <= 0 : totalStock > 10);
    return matchesStock;
  });

  const toggleExpanded = (productId: string) => {
    setExpandedRows((prev) => ({ ...prev, [productId]: !prev[productId] }));
  };

  const productStats = (product: any) => {
    const variants = product.shopify_variants || [];
    const totalStock = variants.reduce((sum: number, v: any) => sum + Number(v.stock || 0), 0);
    const prices = variants.map((v: any) => Number(v.price || 0)).filter((p: number) => !Number.isNaN(p));
    const minPrice = prices.length ? Math.min(...prices) : 0;
    const maxPrice = prices.length ? Math.max(...prices) : 0;
    return { variantsCount: variants.length, totalStock, minPrice, maxPrice };
  };

  const stockBadgeClass = (stock: number) => {
    if (stock <= 0) return "bg-destructive/10 text-destructive";
    if (stock <= 10) return "bg-warning/10 text-warning";
    return "bg-primary/10 text-primary";
  };

  return (
    <div className="w-full space-y-5">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Products</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">{totalCount || 0} products</p>
      </div>

      <div className="flex gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "50ms" }}>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search products..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 rounded-xl h-10 font-body border-border" />
        </div>
        <button onClick={() => setFilterOpen(true)} className="h-10 px-4 rounded-xl border bg-card font-body text-sm text-muted-foreground hover:bg-muted transition-colors tap-scale lg:hidden">Filter</button>
      </div>
      <div className="hidden lg:grid grid-cols-1 md:grid-cols-4 gap-2">
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <Select value={sortBy} onValueChange={(value: "title" | "updated_at" | "created_at" | "vendor") => setSortBy(value)}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="title">Sort: Title</SelectItem>
            <SelectItem value="updated_at">Sort: Updated Date</SelectItem>
            <SelectItem value="created_at">Sort: Created Date</SelectItem>
            <SelectItem value="vendor">Sort: Vendor</SelectItem>
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

      <div className="hidden lg:flex flex-wrap gap-2 overflow-x-auto pb-1 opacity-0 animate-fade-in" style={{ animationDelay: "70ms" }}>
        {statuses.map((s) => (
          <button key={s} onClick={() => setStatusFilter(s)} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>
            {s === "all" ? "All Status" : s}
          </button>
        ))}
        <button onClick={() => setStockFilter("all")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${stockFilter === "all" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>All Stock</button>
        <button onClick={() => setStockFilter("healthy")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${stockFilter === "healthy" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Healthy</button>
        <button onClick={() => setStockFilter("low")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${stockFilter === "low" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Low</button>
        <button onClick={() => setStockFilter("out")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${stockFilter === "out" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Out of stock</button>
      </div>

      <BottomSheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Filter Products" footer={<Button className="w-full rounded-xl h-11 font-body tap-scale" onClick={() => setFilterOpen(false)}>Apply Filters</Button>}>
        <div className="space-y-3">
          <p className="text-sm font-medium font-body text-foreground">Date range</p>
          <div className="grid grid-cols-1 gap-2">
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Sort</p>
          <div className="grid grid-cols-1 gap-2">
            <Select value={sortBy} onValueChange={(value: "title" | "updated_at" | "created_at" | "vendor") => setSortBy(value)}>
              <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="title">Sort: Title</SelectItem>
                <SelectItem value="updated_at">Sort: Updated Date</SelectItem>
                <SelectItem value="created_at">Sort: Created Date</SelectItem>
                <SelectItem value="vendor">Sort: Vendor</SelectItem>
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
          <p className="text-sm font-medium font-body text-foreground">Status</p>
          <div className="flex flex-wrap gap-2">
            {statuses.map((s) => (
              <button key={`m-${s}`} onClick={() => setStatusFilter(s)} className={`px-4 py-2 rounded-xl text-sm font-body transition-colors tap-scale ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {s === "all" ? "All" : s}
              </button>
            ))}
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Stock level</p>
          <div className="flex flex-wrap gap-2">
            {["all", "healthy", "low", "out"].map((s) => (
              <button key={`s-${s}`} onClick={() => setStockFilter(s)} className={`px-4 py-2 rounded-xl text-sm font-body transition-colors tap-scale ${stockFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {s === "all" ? "All" : s}
              </button>
            ))}
          </div>
        </div>
      </BottomSheet>

      {isLoading ? (
        <div className="card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
          <div className="space-y-3">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        </div>
      ) : !filtered.length ? (
        <div className="card-float p-10 text-center opacity-0 animate-fade-in"><p className="text-muted-foreground font-body">No products yet. Run a Shopify sync first.</p></div>
      ) : (
        <>
        <div className="grid grid-cols-1 gap-4 lg:hidden">
          {filtered.map((product: any, i: number) => (
            <div key={product.id} onClick={() => setSelectedProduct(product)} className="card-float p-5 opacity-0 animate-fade-in cursor-pointer" style={{ animationDelay: `${50 + i * 80}ms` }}>
              <div className="flex items-start gap-3 mb-4">
                <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                  {product.featured_image_url ? (
                    <img src={product.featured_image_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <Package className="h-5 w-5 text-primary" />
                  )}
                </div>
                <div>
                  <h3 className="font-heading font-semibold text-foreground">{product.title}</h3>
                  <p className="text-xs text-muted-foreground font-body">{product.vendor}{product.category ? ` · ${product.category}` : ""}</p>
                </div>
              </div>

              <div className="space-y-2">
                {(product.shopify_variants || []).map((v: any) => (
                  <div key={v.id} className="flex items-center justify-between p-2.5 rounded-xl bg-muted/50 text-sm font-body">
                    <div>
                      <span className="text-foreground font-medium">{v.title || "Default"}</span>
                      {v.sku && <span className="text-muted-foreground ml-2">SKU: {v.sku}</span>}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-medium text-foreground">{formatOrderMoney(Number(v.price || 0), null, storeCurrency)}</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex items-center gap-1 ${
                        (v.stock || 0) <= 10 ? "bg-destructive/10 text-destructive" : (v.stock || 0) <= 50 ? "bg-warning/10 text-warning" : "bg-primary/10 text-primary"
                      }`}>
                        {(v.stock || 0) <= 10 && <AlertTriangle className="h-3 w-3" />}
                        {v.stock || 0} in stock
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="hidden lg:block card-float p-0 overflow-hidden opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[48px]"></TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Variants</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Price Range</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((product: any) => {
                const isExpanded = !!expandedRows[product.id];
                const stats = productStats(product);
                return (
                  <Fragment key={product.id}>
                    <TableRow
                      onClick={() => setSelectedProduct(product)}
                      className="cursor-pointer"
                    >
                      <TableCell className="py-3">
                        <button
                          type="button"
                          aria-label={isExpanded ? "Collapse variants" : "Expand variants"}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpanded(product.id);
                          }}
                          className="h-8 w-8 inline-flex items-center justify-center rounded-md border bg-card hover:bg-muted transition-colors"
                        >
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </TableCell>
                      <TableCell className="py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                            {product.featured_image_url ? (
                              <img src={product.featured_image_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                            ) : (
                              <Package className="h-4 w-4 text-primary" />
                            )}
                          </div>
                          <div>
                            <p className="font-medium text-foreground">{product.title}</p>
                            <p className="text-xs text-muted-foreground">{product.category || "Uncategorized"}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="py-3">
                        <span className="inline-flex rounded-full px-2.5 py-1 text-xs font-medium bg-muted text-muted-foreground">
                          {product.status || "—"}
                        </span>
                      </TableCell>
                      <TableCell className="py-3 text-muted-foreground">{product.vendor || "—"}</TableCell>
                      <TableCell className="py-3">{stats.variantsCount}</TableCell>
                      <TableCell className="py-3">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${stockBadgeClass(stats.totalStock)}`}>
                          {stats.totalStock} total
                        </span>
                      </TableCell>
                      <TableCell className="py-3 text-foreground">
                        {stats.minPrice === stats.maxPrice
                          ? formatOrderMoney(stats.minPrice, null, storeCurrency)
                          : `${formatOrderMoney(stats.minPrice, null, storeCurrency)} – ${formatOrderMoney(stats.maxPrice, null, storeCurrency)}`}
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={7} className="py-4">
                          <div className="rounded-xl border bg-background p-3">
                            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Variant Breakdown</p>
                            <div className="space-y-2">
                              {(product.shopify_variants || []).map((v: any) => (
                                <div key={v.id} className="grid grid-cols-4 gap-3 text-sm rounded-lg bg-muted/40 p-2.5">
                                  <div className="col-span-2 min-w-0">
                                    <p className="font-medium text-foreground truncate">{v.title || "Default"}</p>
                                    <p className="text-xs text-muted-foreground truncate">{v.sku || "No SKU"}</p>
                                  </div>
                                  <div className="text-foreground font-medium">{formatOrderMoney(Number(v.price || 0), null, storeCurrency)}</div>
                                  <div>
                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${stockBadgeClass(Number(v.stock || 0))}`}>
                                      {Number(v.stock || 0)} in stock
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
        </>
      )}
      {totalCount > 0 && (
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
      )}

      <Sheet open={!!selectedProduct} onOpenChange={(open) => !open && setSelectedProduct(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Product Details</SheetTitle>
          </SheetHeader>
          {selectedProduct && (
            <div className="space-y-4 mt-4 font-body text-sm">
              <div className="rounded-xl border bg-card p-4">
                <div className="flex items-start gap-3">
                  <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                    {selectedProduct.featured_image_url ? (
                      <img src={selectedProduct.featured_image_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <ImageIcon className="h-5 w-5 text-primary" />
                    )}
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-foreground">{selectedProduct.title}</p>
                    <p className="text-muted-foreground">{selectedProduct.vendor || "Unknown vendor"} {selectedProduct.category ? `· ${selectedProduct.category}` : ""}</p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <span className="inline-flex rounded-full px-2 py-0.5 text-xs bg-muted text-muted-foreground">
                        {(selectedProduct.shopify_variants || []).length} variants
                      </span>
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${stockBadgeClass((selectedProduct.shopify_variants || []).reduce((sum: number, v: any) => sum + Number(v.stock || 0), 0))}`}>
                        {(selectedProduct.shopify_variants || []).reduce((sum: number, v: any) => sum + Number(v.stock || 0), 0)} total stock
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="rounded-xl border p-4 space-y-2">
                <p><span className="text-muted-foreground">Status:</span> {selectedProduct.status || "—"}</p>
                <p><span className="text-muted-foreground">Handle:</span> {selectedProduct.handle || "—"}</p>
                <p><span className="text-muted-foreground">Tags:</span> {selectedProduct.tags || "—"}</p>
              </div>
              <div className="rounded-xl border p-4 space-y-2">
                <p className="font-semibold text-foreground">Variants</p>
                {(selectedProduct.shopify_variants || []).map((v: any) => (
                  <div key={v.id} className="flex items-center justify-between border-b last:border-0 pb-2 last:pb-0">
                    <div className="pr-3">
                      <p className="text-foreground font-medium">{v.title || "Default"}</p>
                      <p className="text-xs text-muted-foreground">{v.sku || "No SKU"} {v.inventory_location ? `· ${v.inventory_location}` : ""}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-foreground font-medium">{formatOrderMoney(Number(v.price || 0), null, storeCurrency)}</p>
                      <p className="text-xs text-muted-foreground">{v.stock || 0} in stock</p>
                    </div>
                  </div>
                ))}
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
