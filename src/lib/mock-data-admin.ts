// Extended mock data for admin views
import type { Order } from "./mock-data";

export interface SalespersonSummary {
  id: string;
  name: string;
  email: string;
  customers_count: number;
  orders_count: number;
  total_revenue: number;
}

export interface SyncLog {
  id: string;
  type: "customers" | "orders" | "products" | "inventory";
  status: "success" | "error" | "running";
  records_synced: number;
  started_at: string;
  completed_at: string | null;
  error_message?: string;
}

export const mockSalespersonSummaries: SalespersonSummary[] = [
  { id: "sp-1", name: "Sarah Mitchell", email: "sarah@udsales.com", customers_count: 5, orders_count: 42, total_revenue: 392000 },
  { id: "sp-2", name: "Ahmed Khan", email: "ahmed@udsales.com", customers_count: 2, orders_count: 38, total_revenue: 277400 },
];

export const mockSyncLogs: SyncLog[] = [
  { id: "sl-1", type: "customers", status: "success", records_synced: 8, started_at: "2025-03-23 09:00:00", completed_at: "2025-03-23 09:00:12" },
  { id: "sl-2", type: "orders", status: "success", records_synced: 15, started_at: "2025-03-23 09:00:12", completed_at: "2025-03-23 09:00:28" },
  { id: "sl-3", type: "products", status: "success", records_synced: 4, started_at: "2025-03-23 09:00:28", completed_at: "2025-03-23 09:00:31" },
  { id: "sl-4", type: "inventory", status: "error", records_synced: 0, started_at: "2025-03-23 09:00:31", completed_at: "2025-03-23 09:00:32", error_message: "Shopify API rate limit exceeded" },
  { id: "sl-5", type: "customers", status: "success", records_synced: 8, started_at: "2025-03-22 09:00:00", completed_at: "2025-03-22 09:00:10" },
  { id: "sl-6", type: "orders", status: "success", records_synced: 12, started_at: "2025-03-22 09:00:10", completed_at: "2025-03-22 09:00:22" },
];

export const mockInventoryLocations = [
  { id: "loc-1", name: "Dubai Warehouse" },
  { id: "loc-2", name: "Abu Dhabi Store" },
];

export interface InventoryItem {
  id: string;
  product: string;
  variant: string;
  sku: string;
  location: string;
  quantity: number;
}

export const mockInventory: InventoryItem[] = [
  { id: "inv-1", product: "Premium Widget A", variant: "Large / Black", sku: "PWA-LB", location: "Dubai Warehouse", quantity: 100 },
  { id: "inv-2", product: "Premium Widget A", variant: "Large / Black", sku: "PWA-LB", location: "Abu Dhabi Store", quantity: 45 },
  { id: "inv-3", product: "Premium Widget A", variant: "Medium / White", sku: "PWA-MW", location: "Dubai Warehouse", quantity: 89 },
  { id: "inv-4", product: "Premium Widget A", variant: "Small / Grey", sku: "PWA-SG", location: "Dubai Warehouse", quantity: 8 },
  { id: "inv-5", product: "Premium Widget A", variant: "Small / Grey", sku: "PWA-SG", location: "Abu Dhabi Store", quantity: 4 },
  { id: "inv-6", product: "Standard Pack B", variant: "Default", sku: "SPB-DEF", location: "Dubai Warehouse", quantity: 230 },
  { id: "inv-7", product: "Economy Pack C", variant: "Small", sku: "EPC-S", location: "Dubai Warehouse", quantity: 510 },
  { id: "inv-8", product: "Economy Pack C", variant: "Medium", sku: "EPC-M", location: "Dubai Warehouse", quantity: 380 },
  { id: "inv-9", product: "Economy Pack C", variant: "Large", sku: "EPC-L", location: "Dubai Warehouse", quantity: 3 },
  { id: "inv-10", product: "Economy Pack C", variant: "Large", sku: "EPC-L", location: "Abu Dhabi Store", quantity: 2 },
  { id: "inv-11", product: "Bulk Supply Kit", variant: "XL", sku: "BSK-XL", location: "Dubai Warehouse", quantity: 67 },
  { id: "inv-12", product: "Bulk Supply Kit", variant: "XXL", sku: "BSK-XXL", location: "Dubai Warehouse", quantity: 42 },
];
