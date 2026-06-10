/** One Dubai reporting day — matches Shopify Admin Analytics single-day filter. */
export function shopifyqlPeriodFactsQueryForDay(day: string): string {
  return `FROM sales SHOW gross_sales, discounts, returns, net_sales, taxes, total_sales, shipping_charges, orders SINCE ${day} UNTIL ${day}`;
}
