/**
 * Contract tests: Edge Function matching logic vs Shopify `custom.referredby` choice list
 * and Settings → Salespersons (`user_roles.salesperson_name`).
 */
import { describe, expect, it } from "vitest";
import {
  findSalespersonRow,
  isShopifyNoReferralChoice,
  labelsMatchShopifyToRole,
  metafieldValueForKeysOrdered,
  REFERRED_BY_METAFIELD_KEYS_ORDERED,
} from "../../supabase/functions/_shared/salesperson-match.ts";

const team = [
  { user_id: "1", salesperson_name: "Simon Hartshorn" },
  { user_id: "2", salesperson_name: "Rob Lister" },
  { user_id: "3", salesperson_name: "Adam Yousuf" },
  { user_id: "4", salesperson_name: "UD LEADS" },
];

describe("salesperson-match (Shopify ↔ app)", () => {
  it("matches choice-list strings exactly as in Shopify definition and Salespersons page", () => {
    expect(labelsMatchShopifyToRole("Simon Hartshorn", "Simon Hartshorn")).toBe(true);
    expect(labelsMatchShopifyToRole("Rob Lister", "Rob Lister")).toBe(true);
    expect(labelsMatchShopifyToRole("Adam Yousuf", "Adam Yousuf")).toBe(true);
    expect(labelsMatchShopifyToRole("UD LEADS", "UD LEADS")).toBe(true);
  });

  it("ignores case differences", () => {
    expect(labelsMatchShopifyToRole("simon hartshorn", "Simon Hartshorn")).toBe(true);
  });

  it("matches tag-style name without space to choice-list name with space", () => {
    expect(labelsMatchShopifyToRole("Rob Lister", "RobLister")).toBe(true);
    expect(labelsMatchShopifyToRole("RobLister", "Rob Lister")).toBe(true);
  });

  it("findSalespersonRow returns user_roles row for Shopify label", () => {
    expect(findSalespersonRow(team, "Simon Hartshorn")?.salesperson_name).toBe("Simon Hartshorn");
  });

  it('treats "No Referrer" as empty referral', () => {
    expect(isShopifyNoReferralChoice("No Referrer")).toBe(true);
    expect(findSalespersonRow(team, "No Referrer")).toBeUndefined();
  });

  it("reads custom.referredby before another namespace referredby", () => {
    const mets = [
      { namespace: "other", key: "referredby", value: "Wrong Person" },
      { namespace: "custom", key: "referredby", value: "Simon Hartshorn" },
    ];
    expect(metafieldValueForKeysOrdered(mets, REFERRED_BY_METAFIELD_KEYS_ORDERED)).toBe("Simon Hartshorn");
  });

  it("strips Referred by: prefix for matching", () => {
    expect(labelsMatchShopifyToRole("Referred by: Rob Lister", "Rob Lister")).toBe(true);
  });
});
