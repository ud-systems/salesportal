import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * Registers the production service worker and prompts when a new build is available.
 * Supabase and edge calls are not cached (see vite workbox runtimeCaching) — this is shell + static assets only.
 */
export function PwaUpdateNotifier() {
  const {
    needRefresh: [needRefreshFlag],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(err) {
      console.error("Service worker registration failed", err);
    },
  });

  const toastShown = useRef(false);

  useEffect(() => {
    if (!needRefreshFlag) {
      toastShown.current = false;
      return;
    }
    if (toastShown.current) return;
    toastShown.current = true;

    toast.message("A new version is available", {
      id: "pwa-update",
      description: "Reload to use the latest CRM changes.",
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: "Reload",
        onClick: () => void updateServiceWorker(true),
      },
    });
  }, [needRefreshFlag, updateServiceWorker]);

  return null;
}
