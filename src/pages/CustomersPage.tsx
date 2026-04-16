import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useCustomerCities, useCustomersPaginated } from "@/hooks/use-shopify-data";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/BottomSheet";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Pagination, PaginationContent, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatOrderMoney } from "@/lib/format";
import { useShopDisplayCurrency } from "@/hooks/use-display-currency";
import { getDashboardRange, toRangeIso, type DatePreset } from "@/lib/dashboard-date-range";
import { loadUserFilterPreset, saveUserFilterPreset } from "@/lib/filter-preset-storage";

export default function CustomersPage() {
  const { data: storeCurrency = "GBP" } = useShopDisplayCurrency();
  const { user, isAdmin } = useAuth();
  const [search, setSearch] = useState("");
  const [cityFilter, setCityFilter] = useState("all");
  const [assignmentFilter, setAssignmentFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<any | null>(null);
  const [page, setPage] = useState(1);
  const [isMobile, setIsMobile] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [preset, setPreset] = useState<DatePreset>("all");
  const [quickRankFilter, setQuickRankFilter] = useState<"all" | "top3" | "bottom3">("all");
  const [sortBy, setSortBy] = useState<"total_revenue" | "total_orders" | "shopify_created_at" | "name">("total_revenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const pageSize = isMobile ? 10 : 15;
  const range = useMemo(() => getDashboardRange(preset, fromDate || undefined, toDate || undefined), [preset, fromDate, toDate]);
  const fromIso = toRangeIso(range.from);
  const toIso = toRangeIso(range.to);

  useEffect(() => {
    const saved = loadUserFilterPreset(user?.id, "customers-page", {
      search: "",
      cityFilter: "all",
      assignmentFilter: "all",
      fromDate: "",
      toDate: "",
      preset: "all" as DatePreset,
      sortBy: "total_revenue" as "total_revenue" | "total_orders" | "shopify_created_at" | "name",
      sortDir: "desc" as "asc" | "desc",
      quickRankFilter: "all" as "all" | "top3" | "bottom3",
    });
    setSearch(saved.search);
    setCityFilter(saved.cityFilter);
    setAssignmentFilter(saved.assignmentFilter);
    setFromDate(saved.fromDate);
    setToDate(saved.toDate);
    setPreset(saved.preset);
    setSortBy(saved.sortBy);
    setSortDir(saved.sortDir);
    setQuickRankFilter(saved.quickRankFilter);
  }, [user?.id]);

  useEffect(() => {
    saveUserFilterPreset(user?.id, "customers-page", {
      search,
      cityFilter,
      assignmentFilter,
      fromDate,
      toDate,
      preset,
      sortBy,
      sortDir,
      quickRankFilter,
    });
  }, [user?.id, search, cityFilter, assignmentFilter, fromDate, toDate, preset, sortBy, sortDir, quickRankFilter]);

  useEffect(() => {
    const update = () => setIsMobile(window.matchMedia("(max-width: 767px)").matches);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const { data: cityData } = useCustomerCities();
  const cities = cityData ?? ["all"];
  const { data, isLoading } = useCustomersPaginated({
    page,
    pageSize,
    search,
    cityFilter,
    assignmentFilter: assignmentFilter as "all" | "assigned" | "unassigned",
    fromDate: fromIso ? fromIso.slice(0, 10) : "",
    toDate: toIso ? toIso.slice(0, 10) : "",
    sortBy,
    sortDir,
  });
  const customers = data?.data ?? [];
  const customersVisible = useMemo(() => {
    if (quickRankFilter === "all") return customers;
    const ranked = [...customers].sort((a, b) => Number(b.total_revenue || 0) - Number(a.total_revenue || 0));
    return quickRankFilter === "top3" ? ranked.slice(0, 3) : ranked.slice(-3);
  }, [customers, quickRankFilter]);
  const totalCount = data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  useEffect(() => {
    setPage(1);
  }, [search, cityFilter, assignmentFilter, pageSize, fromDate, toDate, sortBy, sortDir]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  return (
    <div className="space-y-5 max-w-[1200px]">
      <div className="opacity-0 animate-fade-in">
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">Customers</h1>
        <p className="text-muted-foreground font-body text-sm mt-1">{totalCount} customers</p>
      </div>

      <div className="flex gap-3 opacity-0 animate-fade-in" style={{ animationDelay: "50ms" }}>
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search customers..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 rounded-xl h-10 font-body border-border" />
        </div>
        <button onClick={() => setFilterOpen(true)} className="h-10 px-4 rounded-xl border bg-card font-body text-sm text-muted-foreground hover:bg-muted transition-colors tap-scale lg:hidden">Filter</button>
      </div>
      <div className="hidden lg:grid grid-cols-1 md:grid-cols-5 gap-2">
        <Select value={preset} onValueChange={(v) => setPreset(v as DatePreset)}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Period" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All time</SelectItem>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="week">Last 7 days</SelectItem>
            <SelectItem value="month">This month</SelectItem>
            <SelectItem value="quarter">This quarter</SelectItem>
            <SelectItem value="year">This year</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
        <Select value={sortBy} onValueChange={(value: "total_revenue" | "total_orders" | "shopify_created_at" | "name") => setSortBy(value)}>
          <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="total_revenue">Sort: Revenue</SelectItem>
            <SelectItem value="total_orders">Sort: Orders</SelectItem>
            <SelectItem value="shopify_created_at">Sort: Customer Date</SelectItem>
            <SelectItem value="name">Sort: Name</SelectItem>
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

      <div className="hidden lg:flex flex-wrap items-center gap-2 opacity-0 animate-fade-in" style={{ animationDelay: "70ms" }}>
        <Popover open={cityOpen} onOpenChange={setCityOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={cityOpen}
              className="w-[260px] justify-between rounded-xl font-body"
            >
              {cityFilter === "all" ? "All Cities" : cityFilter}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[260px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search city..." />
              <CommandList>
                <CommandEmpty>No city found.</CommandEmpty>
                <CommandGroup>
                  {cities.map((c) => (
                    <CommandItem
                      key={c}
                      value={c}
                      onSelect={() => {
                        setCityFilter(c);
                        setCityOpen(false);
                      }}
                    >
                      <Check className={cn("mr-2 h-4 w-4", cityFilter === c ? "opacity-100" : "opacity-0")} />
                      {c === "all" ? "All Cities" : c}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <button onClick={() => setAssignmentFilter("all")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${assignmentFilter === "all" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>All Assignments</button>
        <button onClick={() => setAssignmentFilter("assigned")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${assignmentFilter === "assigned" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Assigned</button>
        <button onClick={() => setAssignmentFilter("unassigned")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${assignmentFilter === "unassigned" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Unassigned</button>
        <button onClick={() => setQuickRankFilter("all")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${quickRankFilter === "all" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>All</button>
        <button onClick={() => setQuickRankFilter("top3")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${quickRankFilter === "top3" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Top 3</button>
        <button onClick={() => setQuickRankFilter("bottom3")} className={`px-3 py-1.5 rounded-full text-xs font-medium font-body whitespace-nowrap transition-colors tap-scale ${quickRankFilter === "bottom3" ? "bg-primary text-primary-foreground" : "bg-card border text-muted-foreground hover:bg-muted"}`}>Bottom 3</button>
      </div>

      <BottomSheet open={filterOpen} onClose={() => setFilterOpen(false)} title="Filter Customers" footer={<Button className="w-full rounded-xl h-11 font-body tap-scale" onClick={() => setFilterOpen(false)}>Apply Filters</Button>}>
        <div className="space-y-3">
          <p className="text-sm font-medium font-body text-foreground">Date range</p>
          <div className="grid grid-cols-1 gap-2">
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-10 rounded-xl border bg-card px-3 text-sm font-body" />
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Sort</p>
          <div className="grid grid-cols-1 gap-2">
            <Select value={sortBy} onValueChange={(value: "total_revenue" | "total_orders" | "shopify_created_at" | "name") => setSortBy(value)}>
              <SelectTrigger className="h-10 rounded-xl bg-card px-3 text-sm font-body">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="total_revenue">Sort: Revenue</SelectItem>
                <SelectItem value="total_orders">Sort: Orders</SelectItem>
                <SelectItem value="shopify_created_at">Sort: Customer Date</SelectItem>
                <SelectItem value="name">Sort: Name</SelectItem>
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
          <p className="text-sm font-medium font-body text-foreground">City</p>
          <div className="rounded-xl border bg-card p-2">
            <Command>
              <CommandInput placeholder="Search city..." />
              <CommandList className="max-h-44">
                <CommandEmpty>No city found.</CommandEmpty>
                <CommandGroup>
                  {cities.map((c) => (
                    <CommandItem key={c} value={c} onSelect={() => setCityFilter(c)}>
                      <Check className={cn("mr-2 h-4 w-4", cityFilter === c ? "opacity-100" : "opacity-0")} />
                      {c === "all" ? "All Cities" : c}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
          <p className="text-sm font-medium font-body text-foreground pt-1">Assignment</p>
          <div className="flex flex-wrap gap-2">
            {["all", "assigned", "unassigned"].map((v) => (
              <button key={v} onClick={() => setAssignmentFilter(v)} className={`px-4 py-2 rounded-xl text-sm font-body transition-colors tap-scale ${assignmentFilter === v ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
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
      ) : customers.length === 0 ? (
        <div className="card-float p-10 text-center opacity-0 animate-fade-in"><p className="text-muted-foreground font-body">No customers found. Run a Shopify sync first.</p></div>
      ) : (
        <>
          <div className="hidden md:block card-float p-5 opacity-0 animate-fade-in" style={{ animationDelay: "100ms" }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-body">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2.5 font-medium">Name</th>
                    <th className="text-left py-2.5 font-medium">Store</th>
                    <th className="text-left py-2.5 font-medium">City</th>
                    {isAdmin && <th className="text-left py-2.5 font-medium">Salesperson</th>}
                    <th className="text-right py-2.5 font-medium">Orders</th>
                    <th className="text-right py-2.5 font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {customersVisible.map((c) => (
                    <tr key={c.id} onClick={() => setSelectedCustomer(c)} className="border-b last:border-0 hover:bg-muted/50 transition-colors cursor-pointer">
                      <td className="py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-full gradient-primary flex items-center justify-center shrink-0">
                            <span className="text-primary-foreground text-[10px] font-bold font-heading">{c.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</span>
                          </div>
                          <div><p className="font-medium text-foreground">{c.name}</p><p className="text-xs text-muted-foreground">{c.email}</p></div>
                        </div>
                      </td>
                      <td className="py-3 text-muted-foreground">{c.store_name}</td>
                      <td className="py-3 text-muted-foreground">{c.city}</td>
                      {isAdmin && (
                        <td className="py-3">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${!c.sp_assigned || c.sp_assigned === "Unassigned" ? "bg-warning/10 text-warning" : "bg-primary/10 text-primary"}`}>{c.sp_assigned || "Unassigned"}</span>
                        </td>
                      )}
                      <td className="py-3 text-right font-medium text-foreground">{c.total_orders || 0}</td>
                      <td className="py-3 text-right font-medium text-foreground">
                        {formatOrderMoney(Number(c.total_revenue || 0), c.spend_currency, storeCurrency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="md:hidden space-y-3">
            {customersVisible.map((c, i) => (
              <div key={c.id} className="card-float p-4 tap-scale opacity-0 animate-fade-in" style={{ animationDelay: `${100 + i * 50}ms` }}>
                <div className="flex items-center gap-3 mb-3">
                  <div className="h-10 w-10 rounded-full gradient-primary flex items-center justify-center shrink-0">
                    <span className="text-primary-foreground text-xs font-bold font-heading">{c.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-foreground text-sm truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground">{c.store_name} · {c.city}</p>
                  </div>
                </div>
                {isAdmin && (
                  <div className="mb-2">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${!c.sp_assigned || c.sp_assigned === "Unassigned" ? "bg-warning/10 text-warning" : "bg-primary/10 text-primary"}`}>{c.sp_assigned || "Unassigned"}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground font-body">{c.total_orders || 0} orders</span>
                  <span className="font-medium text-foreground font-body">
                    {formatOrderMoney(Number(c.total_revenue || 0), c.spend_currency, storeCurrency)}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="card-float p-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground font-body px-2">
              <span>Showing {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, totalCount)} of {quickRankFilter === "all" ? totalCount : customersVisible.length}</span>
              <span>Page {page} / {totalPages}</span>
            </div>
            <Pagination className="mt-2">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      if (page > 1) setPage(page - 1);
                    }}
                    className={page <= 1 ? "pointer-events-none opacity-50" : ""}
                  />
                </PaginationItem>
                {Array.from({ length: Math.min(5, totalPages) }).map((_, i) => {
                  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
                  const pageNum = start + i;
                  if (pageNum > totalPages) return null;
                  return (
                    <PaginationItem key={pageNum}>
                      <PaginationLink
                        href="#"
                        isActive={pageNum === page}
                        onClick={(e) => {
                          e.preventDefault();
                          setPage(pageNum);
                        }}
                      >
                        {pageNum}
                      </PaginationLink>
                    </PaginationItem>
                  );
                })}
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      if (page < totalPages) setPage(page + 1);
                    }}
                    className={page >= totalPages ? "pointer-events-none opacity-50" : ""}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </>
      )}

      <Sheet open={!!selectedCustomer} onOpenChange={(open) => !open && setSelectedCustomer(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Customer Details</SheetTitle>
          </SheetHeader>
          {selectedCustomer && (
            <div className="space-y-4 mt-4 font-body text-sm">
              <div className="rounded-xl border bg-card p-4">
                <p className="text-lg font-semibold text-foreground">{selectedCustomer.name}</p>
                <p className="text-muted-foreground">{selectedCustomer.email || "No email"} · {selectedCustomer.phone || "No phone"}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">Orders</p><p className="font-semibold">{selectedCustomer.total_orders || 0}</p></div>
                <div className="rounded-xl border p-3"><p className="text-xs text-muted-foreground">Revenue</p><p className="font-semibold">{formatOrderMoney(Number(selectedCustomer.total_revenue || 0), selectedCustomer.spend_currency, storeCurrency)}</p></div>
              </div>
              <div className="rounded-xl border p-4 space-y-2">
                <p><span className="text-muted-foreground">Store:</span> {selectedCustomer.store_name || "—"}</p>
                <p><span className="text-muted-foreground">City:</span> {selectedCustomer.city || "—"}</p>
                <p><span className="text-muted-foreground">Address:</span> {[selectedCustomer.address1, selectedCustomer.address2, selectedCustomer.province, selectedCustomer.country, selectedCustomer.zip].filter(Boolean).join(", ") || "—"}</p>
                <p><span className="text-muted-foreground">Salesperson:</span> {selectedCustomer.sp_assigned || "Unassigned"}</p>
                <p><span className="text-muted-foreground">Referred by:</span> {selectedCustomer.referred_by || "—"}</p>
                <p><span className="text-muted-foreground">Account state:</span> {selectedCustomer.account_state || "—"}</p>
                <p><span className="text-muted-foreground">Locale:</span> {selectedCustomer.locale || "—"}</p>
                <p><span className="text-muted-foreground">Note:</span> {selectedCustomer.customer_note || "—"}</p>
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
