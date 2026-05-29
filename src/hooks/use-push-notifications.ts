import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import {
  fetchVapidPublicKey,
  hasPushSubscriptionInDb,
  isPushAvailableOnThisDevice,
  isPushApiSupported,
  isIosDevice,
  isStandaloneDisplay,
  savePushSubscriptionToDb,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
} from "@/lib/push-notifications";

export function usePushNotifications() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const [busy, setBusy] = useState(false);

  const supported = isPushApiSupported();
  const availableOnDevice = isPushAvailableOnThisDevice();

  const { data: vapidPublicKey, isLoading: loadingKey } = useQuery({
    queryKey: ["push-vapid-public-key"],
    queryFn: fetchVapidPublicKey,
    staleTime: 5 * 60_000,
    enabled: supported && Boolean(user?.hasDbRole),
  });

  const pushEnabledServer = Boolean(vapidPublicKey);

  const { data: subscribed = false, isLoading: loadingSub } = useQuery({
    queryKey: ["push-subscription-active", user?.id],
    queryFn: () => hasPushSubscriptionInDb(user!.id),
    enabled: Boolean(user?.id && user.hasDbRole),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    const refresh = () => setPermission(Notification.permission);
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);

  const enablePush = useCallback(async () => {
    if (!user?.id || !vapidPublicKey) return;
    setBusy(true);
    try {
      const payload = await subscribeBrowserPush(vapidPublicKey);
      await savePushSubscriptionToDb(user.id, payload);
      setPermission(Notification.permission);
      await qc.invalidateQueries({ queryKey: ["push-subscription-active", user.id] });
    } finally {
      setBusy(false);
    }
  }, [user?.id, vapidPublicKey, qc]);

  const disablePush = useCallback(async () => {
    if (!user?.id) return;
    setBusy(true);
    try {
      await unsubscribeBrowserPush(user.id);
      await qc.invalidateQueries({ queryKey: ["push-subscription-active", user.id] });
    } finally {
      setBusy(false);
    }
  }, [user?.id, qc]);

  const statusMessage = (() => {
    if (!supported) return "This browser does not support push notifications.";
    if (isIosDevice() && !isStandaloneDisplay()) {
      return "On iPhone/iPad, install the CRM to your home screen first, then enable alerts here.";
    }
    if (!pushEnabledServer && !loadingKey) {
      return "Push is not configured on the server yet. Ask an admin to set up VAPID keys in Settings.";
    }
    if (permission === "denied") {
      return "Notifications are blocked in browser settings. Allow notifications for this site, then try again.";
    }
    return null;
  })();

  return {
    supported,
    availableOnDevice,
    pushEnabledServer,
    vapidPublicKey,
    subscribed,
    permission,
    busy,
    loading: loadingKey || loadingSub,
    statusMessage,
    enablePush,
    disablePush,
  };
}
