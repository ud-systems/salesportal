import { useEffect, useState } from "react";

/**
 * Tracks the browser's online/offline state via `navigator.onLine`.
 * Note: `navigator.onLine === true` only means a network interface is present —
 * it does not guarantee Supabase reachability. Callers should still surface
 * query errors as authoritative; this hook is for global UX cues only.
 */
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    setIsOnline(navigator.onLine);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return isOnline;
}
