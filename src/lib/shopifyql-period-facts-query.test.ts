import { describe, expect, it } from "vitest";
import { shopifyqlPeriodFactsQueryForDay } from "@/lib/shopifyql-period-facts-query";

describe("shopifyqlPeriodFactsQueryForDay", () => {
  it("uses the same SINCE and UNTIL date for a single reporting day", () => {
    const q = shopifyqlPeriodFactsQueryForDay("2026-06-08");
    expect(q).toContain("SINCE 2026-06-08 UNTIL 2026-06-08");
    expect(q).not.toContain("UNTIL 2026-06-09");
  });
});
