// Mock data for the UD Sales Portal
export const mockSalesperson = {
  id: "sp-1",
  name: "Sarah Mitchell",
  email: "sarah@udsales.com",
  role: "salesperson" as const,
};

export const mockAdmin = {
  id: "admin-1",
  name: "James Carter",
  email: "james@udsales.com",
  role: "admin" as const,
};

export interface Customer {
  id: string;
  shopify_customer_id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  store: string;
  sp_assigned: string;
  total_orders: number;
  total_revenue: number;
  created_at: string;
}

export interface Order {
  id: string;
  shopify_order_id: string;
  order_number: string;
  customer_name: string;
  customer_id: string;
  total: number;
  financial_status: "paid" | "pending" | "refunded" | "partially_paid";
  fulfillment_status: "fulfilled" | "unfulfilled" | "partial";
  created_at: string;
  items: OrderItem[];
}

export interface OrderItem {
  id: string;
  product: string;
  variant: string;
  quantity: number;
  price: number;
}

export interface Product {
  id: string;
  title: string;
  vendor: string;
  category: string;
  variants: Variant[];
}

export interface Variant {
  id: string;
  sku: string;
  title: string;
  price: number;
  stock: number;
}

export const mockCustomers: Customer[] = [
  { id: "c1", shopify_customer_id: "sc1", name: "Al Noor Trading", email: "info@alnoor.ae", phone: "+971501234567", city: "Dubai", store: "Al Noor Main", sp_assigned: "Sarah Mitchell", total_orders: 45, total_revenue: 128500, created_at: "2024-01-15" },
  { id: "c2", shopify_customer_id: "sc2", name: "Gulf Star Electronics", email: "orders@gulfstar.ae", phone: "+971502345678", city: "Abu Dhabi", store: "Gulf Star HQ", sp_assigned: "Sarah Mitchell", total_orders: 32, total_revenue: 95200, created_at: "2024-02-10" },
  { id: "c3", shopify_customer_id: "sc3", name: "Desert Bloom LLC", email: "buy@desertbloom.ae", phone: "+971503456789", city: "Sharjah", store: "Desert Bloom", sp_assigned: "Sarah Mitchell", total_orders: 28, total_revenue: 72300, created_at: "2024-03-05" },
  { id: "c4", shopify_customer_id: "sc4", name: "Oasis Supplies", email: "info@oasis.ae", phone: "+971504567890", city: "Dubai", store: "Oasis Central", sp_assigned: "Sarah Mitchell", total_orders: 19, total_revenue: 54800, created_at: "2024-04-20" },
  { id: "c5", shopify_customer_id: "sc5", name: "Marina Bay Traders", email: "trade@marinabay.ae", phone: "+971505678901", city: "Ajman", store: "Marina Store", sp_assigned: "Sarah Mitchell", total_orders: 15, total_revenue: 41200, created_at: "2024-05-12" },
  { id: "c6", shopify_customer_id: "sc6", name: "Palm Enterprises", email: "hello@palm.ae", phone: "+971506789012", city: "RAK", store: "Palm Main", sp_assigned: "Ahmed Khan", total_orders: 38, total_revenue: 112000, created_at: "2024-01-22" },
  { id: "c7", shopify_customer_id: "sc7", name: "Falcon Industries", email: "sales@falcon.ae", phone: "+971507890123", city: "Dubai", store: "Falcon HQ", sp_assigned: "Ahmed Khan", total_orders: 52, total_revenue: 165400, created_at: "2024-02-08" },
  { id: "c8", shopify_customer_id: "sc8", name: "Skyline Retail", email: "info@skyline.ae", phone: "+971508901234", city: "Abu Dhabi", store: "Skyline Mall", sp_assigned: "Unassigned", total_orders: 8, total_revenue: 22100, created_at: "2024-06-01" },
];

export const mockOrders: Order[] = [
  { id: "o1", shopify_order_id: "so1", order_number: "#UD-1042", customer_name: "Al Noor Trading", customer_id: "c1", total: 4250, financial_status: "paid", fulfillment_status: "fulfilled", created_at: "2025-03-20", items: [{ id: "i1", product: "Premium Widget A", variant: "Large / Black", quantity: 10, price: 250 }, { id: "i2", product: "Standard Pack B", variant: "Default", quantity: 5, price: 350 }] },
  { id: "o2", shopify_order_id: "so2", order_number: "#UD-1041", customer_name: "Gulf Star Electronics", customer_id: "c2", total: 7800, financial_status: "paid", fulfillment_status: "fulfilled", created_at: "2025-03-19", items: [{ id: "i3", product: "Bulk Supply Kit", variant: "XL", quantity: 20, price: 390 }] },
  { id: "o3", shopify_order_id: "so3", order_number: "#UD-1040", customer_name: "Desert Bloom LLC", customer_id: "c3", total: 2100, financial_status: "pending", fulfillment_status: "unfulfilled", created_at: "2025-03-18", items: [{ id: "i4", product: "Economy Pack C", variant: "Small", quantity: 30, price: 70 }] },
  { id: "o4", shopify_order_id: "so4", order_number: "#UD-1039", customer_name: "Oasis Supplies", customer_id: "c4", total: 5600, financial_status: "paid", fulfillment_status: "partial", created_at: "2025-03-17", items: [{ id: "i5", product: "Premium Widget A", variant: "Medium / White", quantity: 8, price: 700 }] },
  { id: "o5", shopify_order_id: "so5", order_number: "#UD-1038", customer_name: "Al Noor Trading", customer_id: "c1", total: 3200, financial_status: "paid", fulfillment_status: "fulfilled", created_at: "2025-03-15", items: [{ id: "i6", product: "Standard Pack B", variant: "Default", quantity: 8, price: 400 }] },
  { id: "o6", shopify_order_id: "so6", order_number: "#UD-1037", customer_name: "Marina Bay Traders", customer_id: "c5", total: 1850, financial_status: "refunded", fulfillment_status: "fulfilled", created_at: "2025-03-14", items: [{ id: "i7", product: "Economy Pack C", variant: "Medium", quantity: 25, price: 74 }] },
  { id: "o7", shopify_order_id: "so7", order_number: "#UD-1036", customer_name: "Gulf Star Electronics", customer_id: "c2", total: 9200, financial_status: "paid", fulfillment_status: "fulfilled", created_at: "2025-03-12", items: [{ id: "i8", product: "Bulk Supply Kit", variant: "XXL", quantity: 20, price: 460 }] },
  { id: "o8", shopify_order_id: "so8", order_number: "#UD-1035", customer_name: "Desert Bloom LLC", customer_id: "c3", total: 4100, financial_status: "partially_paid", fulfillment_status: "unfulfilled", created_at: "2025-03-10", items: [{ id: "i9", product: "Premium Widget A", variant: "Large / Black", quantity: 12, price: 341.67 }] },
];

export const mockProducts: Product[] = [
  { id: "p1", title: "Premium Widget A", vendor: "UD Manufacturing", category: "Widgets", variants: [
    { id: "v1", sku: "PWA-LB", title: "Large / Black", price: 250, stock: 145 },
    { id: "v2", sku: "PWA-MW", title: "Medium / White", price: 220, stock: 89 },
    { id: "v3", sku: "PWA-SG", title: "Small / Grey", price: 180, stock: 12 },
  ]},
  { id: "p2", title: "Standard Pack B", vendor: "UD Manufacturing", category: "Packs", variants: [
    { id: "v4", sku: "SPB-DEF", title: "Default", price: 350, stock: 230 },
  ]},
  { id: "p3", title: "Economy Pack C", vendor: "ValueLine", category: "Packs", variants: [
    { id: "v5", sku: "EPC-S", title: "Small", price: 70, stock: 510 },
    { id: "v6", sku: "EPC-M", title: "Medium", price: 74, stock: 380 },
    { id: "v7", sku: "EPC-L", title: "Large", price: 85, stock: 5 },
  ]},
  { id: "p4", title: "Bulk Supply Kit", vendor: "UD Manufacturing", category: "Kits", variants: [
    { id: "v8", sku: "BSK-XL", title: "XL", price: 390, stock: 67 },
    { id: "v9", sku: "BSK-XXL", title: "XXL", price: 460, stock: 42 },
  ]},
];

export const mockRevenueData = [
  { month: "Oct", revenue: 42000 },
  { month: "Nov", revenue: 58000 },
  { month: "Dec", revenue: 51000 },
  { month: "Jan", revenue: 63000 },
  { month: "Feb", revenue: 72000 },
  { month: "Mar", revenue: 68000 },
];

export const mockOrdersOverTime = [
  { month: "Oct", orders: 18 },
  { month: "Nov", orders: 24 },
  { month: "Dec", orders: 21 },
  { month: "Jan", orders: 28 },
  { month: "Feb", orders: 35 },
  { month: "Mar", orders: 31 },
];
