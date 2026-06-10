import { describe, expect, it } from "vitest";
import {
  dubaiLastNDays,
  resolvePeriodFactsSyncDays,
} from "@/lib/shopify-analytics-period-facts-sync-days";
import { SHOPIFY_ANALYTICS_EPOCH_YMD } from "@/lib/shopify-analytics-epoch";

describe("resolvePeriodFactsSyncDays", () => {
  it("syncs from analytics epoch through today", () => {
    const days = resolvePeriodFactsSyncDays("2026-06-09");
    expect(days[0]).toBe(SHOPIFY_ANALYTICS_EPOCH_YMD);
    expect(days[days.length - 1]).toBe("2026-06-09");
    expect(days).toContain("2026-06-08");
    expect(days).toContain("2024-11-01");
  });

  it("covers last 7 days for webhook refresh helper", () => {
    const days = dubaiLastNDays(7, "2026-06-09");
    expect(days).toEqual([
      "2026-06-03",
      "2026-06-04",
      "2026-06-05",
      "2026-06-06",
      "2026-06-07",
      "2026-06-08",
      "2026-06-09",
    ]);
  });
});
