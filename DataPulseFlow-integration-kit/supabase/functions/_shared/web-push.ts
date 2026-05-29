import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import webpush from "npm:web-push@3.6.7";

export type WebPushPayload = {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  type?: string;
};

type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

let vapidConfigured = false;

function configureVapid(): boolean {
  if (vapidConfigured) return true;
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY")?.trim();
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY")?.trim();
  const subject = Deno.env.get("VAPID_SUBJECT")?.trim() || "mailto:sales@uniquedistribution.co.uk";
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

export function isWebPushConfigured(): boolean {
  return configureVapid();
}

export async function resolveVapidPublicKey(supabase: SupabaseClient): Promise<string | null> {
  const fromEnv = Deno.env.get("VAPID_PUBLIC_KEY")?.trim();
  if (fromEnv) return fromEnv;
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "vapid_public_key")
    .maybeSingle();
  const fromDb = (data as { value?: string } | null)?.value?.trim();
  return fromDb || null;
}

export async function sendWebPushToSubscription(
  row: PushSubscriptionRow,
  payload: WebPushPayload,
): Promise<"sent" | "gone" | "failed"> {
  if (!configureVapid()) return "failed";
  try {
    await webpush.sendNotification(
      {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      },
      JSON.stringify(payload),
    );
    return "sent";
  } catch (err: unknown) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status === 404 || status === 410) return "gone";
    console.error("web-push send failed:", (err as Error)?.message || err);
    return "failed";
  }
}

export async function sendWebPushToUserIds(
  supabase: SupabaseClient,
  userIds: string[],
  payload: WebPushPayload,
): Promise<{ sent: number; removed: number }> {
  if (!configureVapid() || !userIds.length) return { sent: 0, removed: 0 };

  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  const { data: rows, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", uniqueIds);

  if (error) {
    console.error("push_subscriptions lookup:", error.message);
    return { sent: 0, removed: 0 };
  }

  let sent = 0;
  let removed = 0;
  for (const row of (rows || []) as PushSubscriptionRow[]) {
    const outcome = await sendWebPushToSubscription(row, payload);
    if (outcome === "sent") {
      sent += 1;
      continue;
    }
    if (outcome === "gone") {
      await supabase.from("push_subscriptions").delete().eq("id", row.id);
      removed += 1;
    }
  }
  return { sent, removed };
}
