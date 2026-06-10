import { describe, expect, it } from "vitest";
import { getDashboardRange, toRangeIso, SHOPIFY_ANALYTICS_EPOCH_YMD } from "@/lib/dashboard-date-range";
import {
  storeDayEndExclusiveIsoFromYmd,
  storeDayStartIsoFromYmd,
} from "@/lib/shopify-reporting-timezone";

describe("dashboard-date-range (Asia/Dubai)", () => {
  it("maps Today to Dubai midnight boundaries as exclusive-end UTC", () => {
    const range = getDashboardRange("today", undefined, undefined, new Date("2026-06-09T12:00:00.000Z"));
    expect(toRangeIso(range.from)).toBe("2026-06-08T20:00:00.000Z");
    expect(toRangeIso(range.to)).toBe("2026-06-09T20:00:00.000Z");
  });

  it("maps Yesterday to the prior Dubai calendar day with exclusive end", () => {
    const range = getDashboardRange("yesterday", undefined, undefined, new Date("2026-06-09T12:00:00.000Z"));
    expect(toRangeIso(range.from)).toBe("2026-06-07T20:00:00.000Z");
    expect(toRangeIso(range.to)).toBe("2026-06-08T20:00:00.000Z");
  });

  it("converts custom YMD using Dubai store timezone", () => {
    expect(storeDayStartIsoFromYmd("2026-06-09")).toBe("2026-06-08T20:00:00.000Z");
    expect(storeDayEndExclusiveIsoFromYmd("2026-06-09")).toBe("2026-06-09T20:00:00.000Z");
  });

  it("uses exclusive end for custom ranges", () => {
    const range = getDashboardRange("custom", "2026-06-01", "2026-06-09", new Date("2026-06-09T12:00:00.000Z"));
    expect(toRangeIso(range.from)).toBe("2026-05-31T20:00:00.000Z");
    expect(toRangeIso(range.to)).toBe("2026-06-09T20:00:00.000Z");
  });

  it("maps All time to analytics epoch through end of today (Dubai)", () => {
    const range = getDashboardRange("all", undefined, undefined, new Date("2026-06-09T12:00:00.000Z"));
    expect(range.from).not.toBeNull();
    expect(range.to).not.toBeNull();
    expect(toRangeIso(range.from)).toBe(
      storeDayStartIsoFromYmd(SHOPIFY_ANALYTICS_EPOCH_YMD),
    );
    expect(toRangeIso(range.to)).toBe("2026-06-09T20:00:00.000Z");
  });
});
