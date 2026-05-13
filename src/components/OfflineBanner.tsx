import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online-status";

/**
 * Global indicator surfaced when the browser reports `navigator.onLine === false`.
 *
 * Because Supabase calls bypass the service worker (`NetworkOnly` in vite.config),
 * mutations and queries will fail while offline — this banner tells the user *why*
 * and is the only piece of UI that explicitly acknowledges offline state.
 */
export function OfflineBanner() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-40 -mx-4 mb-4 flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-xs font-body text-amber-900 dark:text-amber-100 lg:-mx-6 lg:px-6"
    >
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1 leading-snug">
        You&apos;re offline. Recently viewed pages still load, but new data and saves will retry when you reconnect.
      </span>
    </div>
  );
}
