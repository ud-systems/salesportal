import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

function refundAmountFromJson(refund: Record<string, unknown>): number {
  const lineItems = (refund.refund_line_items as Array<{ subtotal?: number | string }> | undefined) || [];
  let sum = 0;
  for (const row of lineItems) {
    const n = Number(row.subtotal ?? 0);
    if (Number.isFinite(n)) sum += n;
  }
  const adjustments = (refund.order_adjustments as Array<{ amount?: number | string }> | undefined) || [];
  for (const row of adjustments) {
    const n = Math.abs(Number(row.amount ?? 0));
    if (Number.isFinite(n)) sum += n;
  }
  return Math.round(sum * 100) / 100;
}

/** Persist Shopify refund events from REST webhook payload (refund processed_at analytics). */
export async function syncRefundEventsFromWebhookPayload(
  supabase: SupabaseClient,
  orderId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const refunds = (payload.refunds as Record<string, unknown>[] | undefined) || [];
  if (!refunds.length) return;

  for (const refund of refunds) {
    const shopifyRefundId = Number(refund.id);
    const processedAt = typeof refund.processed_at === "string" ? refund.processed_at : null;
    if (!Number.isFinite(shopifyRefundId) || !processedAt) continue;
    const amount = refundAmountFromJson(refund);
    if (amount <= 0) continue;

    const { error } = await supabase.from("shopify_refund_events").upsert(
      {
        shopify_refund_id: shopifyRefundId,
        order_id: orderId,
        amount,
        processed_at: processedAt,
      },
      { onConflict: "shopify_refund_id" },
    );
    if (error) {
      console.warn("syncRefundEventsFromWebhookPayload failed", shopifyRefundId, error.message);
    }
  }
}
