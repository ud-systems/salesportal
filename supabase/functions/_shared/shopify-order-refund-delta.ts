import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

/** Record incremental refund when totalRefundedSet increases (Shopify refund-date analytics). */
export async function recordRefundDeltaIfIncreased(
  supabase: SupabaseClient,
  orderId: string,
  previousRefunded: number | null | undefined,
  nextRefunded: number | null | undefined,
): Promise<void> {
  const prev = Number(previousRefunded ?? 0);
  const next = Number(nextRefunded ?? 0);
  if (!Number.isFinite(prev) || !Number.isFinite(next) || next <= prev) return;
  const delta = Math.round((next - prev) * 100) / 100;
  if (delta <= 0) return;
  const { error } = await supabase.from("shopify_order_refund_deltas").insert({
    order_id: orderId,
    amount: delta,
    recorded_at: new Date().toISOString(),
  });
  if (error) {
    console.warn("recordRefundDeltaIfIncreased failed", orderId, error.message);
  }
}
