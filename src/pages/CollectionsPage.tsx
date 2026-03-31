import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useCollectionsPaginated } from "@/hooks/use-shopify-data";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/BottomSheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";

export default function CollectionsPage() {
  const [search, setSearch] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [isMobile, setIsMobile] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sortBy, setSortBy] = useState<"title" | "updated_at">("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const pageSize = isMobile ? 10 : 15;
  const { data, isLoading } = useCollectionsPaginated({ page, pageSize, search, fromDate, toDate, sortBy, sortDir });
  const collections = data?.data ?? [];
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
  }, [search, pageSize, fromDate, toDate, sortBy, sortDir]);

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div>
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Collections</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">{totalCount} collections</p>
      </div>
      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search collections..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 rounded-xl h-10 font-body border-border" />
        </div>
        <button onClick={() => setFilterOpen(true)} className="h-10 px-4 rounded-xl border bg-card font-body text-sm text-muted-foreground hover:bg-muted transition-colors tap-scale lg:hidden">Filter</button>
      </div>
      <div className="hidden lg:grid grid-cols-1 md:grid-cols-4 gap-2">
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <Select value={sortBy} onValueChange={(value: "title" | "updated_at") => setSortBy(value)}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated_at">Sort: Updated Date</SelectItem>
            <SelectItem value="title">Sort: Title</SelectItem>
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
      <BottomSheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Filter Collections" footer={<Button className="w-full rounded-xl h-11 font-body tap-scale" onClick={() => setFilterOpen(false)}>Apply Filters</Button>}>
        <div className="space-y-3">
          <p className="text-sm font-medium font-body text-foreground">Date range</p>
          <div className="grid grid-cols-1 gap-2">
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Sort</p>
          <div className="grid grid-cols-1 gap-2">
            <Select value={sortBy} onValueChange={(value: "title" | "updated_at") => setSortBy(value)}>
              <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated_at">Sort: Updated Date</SelectItem>
                <SelectItem value="title">Sort: Title</SelectItem>
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
        </div>
      </BottomSheet>
      {isLoading ? (
        <div className="card-float p-5">
          <div className="space-y-3">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        </div>
      ) : collections.length === 0 ? (
        <div className="card-float p-10 text-center"><p className="text-muted-foreground font-body">No collections found. Run sync to import collections.</p></div>
      ) : (
        <div className="card-float p-5 overflow-x-auto">
          <table className="w-full text-sm font-body">
            <thead><tr className="border-b text-muted-foreground"><th className="text-left py-2.5">Title</th><th className="text-left py-2.5">Handle</th><th className="text-right py-2.5">Products</th><th className="text-left py-2.5">Type</th><th className="text-left py-2.5">Updated</th></tr></thead>
            <tbody>
              {collections.map((c: any) => (
                <tr key={c.id} className="border-b last:border-0">
                  <td className="py-3 font-medium text-foreground">{c.title}</td>
                  <td className="py-3 text-muted-foreground">{c.handle || "—"}</td>
                  <td className="py-3 text-right text-foreground">{c.products_count ?? 0}</td>
                  <td className="py-3 text-muted-foreground">{c.collection_type || "custom"}</td>
                  <td className="py-3 text-muted-foreground">{c.updated_at ? new Date(c.updated_at).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {totalCount > 0 && (
        <Pagination>
          <PaginationContent>
            <PaginationItem><PaginationPrevious href="#" onClick={(e) => { e.preventDefault(); if (page > 1) setPage(page - 1); }} className={page <= 1 ? "pointer-events-none opacity-50" : ""} /></PaginationItem>
            {Array.from({ length: Math.min(5, totalPages) }).map((_, i) => {
              const start = Math.max(1, Math.min(page - 2, totalPages - 4));
              const pageNum = start + i;
              if (pageNum > totalPages) return null;
              return <PaginationItem key={pageNum}><PaginationLink href="#" isActive={pageNum === page} onClick={(e) => { e.preventDefault(); setPage(pageNum); }}>{pageNum}</PaginationLink></PaginationItem>;
            })}
            <PaginationItem><PaginationNext href="#" onClick={(e) => { e.preventDefault(); if (page < totalPages) setPage(page + 1); }} className={page >= totalPages ? "pointer-events-none opacity-50" : ""} /></PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
