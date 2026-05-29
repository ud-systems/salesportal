import { supabase } from "@/integrations/supabase/client";

const PUSH_CONFIG_CACHE_KEY = "uddash_push_vapid_public_key";

export function isPushApiSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function isIosDevice(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Mac") && "ontouchend" in document);
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

/** iOS only delivers Web Push to home-screen PWAs (16.4+). */
export function isPushAvailableOnThisDevice(): boolean {
  if (!isPushApiSupported()) return false;
  if (isIosDevice() && !isStandaloneDisplay()) return false;
  return true;
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  const fromEnv = import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim();
  if (fromEnv) return fromEnv;

  const cached = sessionStorage.getItem(PUSH_CONFIG_CACHE_KEY);
  if (cached) return cached;

  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!base) return null;

  try {
    const res = await fetch(`${base}/functions/v1/push-config`);
    if (!res.ok) return null;
    const json = (await res.json()) as { publicKey?: string | null; enabled?: boolean };
    const key = json.publicKey?.trim() || null;
    if (key) sessionStorage.setItem(PUSH_CONFIG_CACHE_KEY, key);
    return key;
  } catch {
    return null;
  }
}

export async function waitForServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing?.active) return existing;
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export type PushSubscriptionPayload = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export function parsePushSubscription(sub: PushSubscription): PushSubscriptionPayload | null {
  const json = sub.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, p256dh, auth };
}

export async function subscribeBrowserPush(publicKey: string): Promise<PushSubscriptionPayload> {
  const registration = await waitForServiceWorkerRegistration();
  if (!registration) throw new Error("App is still loading. Wait a moment and try again.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  let sub = await registration.pushManager.getSubscription();
  if (!sub) {
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  const parsed = parsePushSubscription(sub);
  if (!parsed) throw new Error("Could not read push subscription from the browser.");
  return parsed;
}

export async function savePushSubscriptionToDb(userId: string, payload: PushSubscriptionPayload) {
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint: payload.endpoint,
      p256dh: payload.p256dh,
      auth: payload.auth,
      user_agent: navigator.userAgent?.slice(0, 500) || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,endpoint" },
  );
  if (error) throw error;
}

export async function unsubscribeBrowserPush(userId: string) {
  const registration = await waitForServiceWorkerRegistration();
  const sub = registration ? await registration.pushManager.getSubscription() : null;
  if (sub) await sub.unsubscribe();

  const { error } = await supabase.from("push_subscriptions").delete().eq("user_id", userId);
  if (error) throw error;
}

export async function hasPushSubscriptionInDb(userId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("push_subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw error;
  return (count ?? 0) > 0;
}
