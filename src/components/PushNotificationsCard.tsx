import { BellRing, Loader2, Smartphone } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { toast } from "sonner";
import { Link } from "react-router-dom";

export function PushNotificationsCard() {
  const {
    availableOnDevice,
    pushEnabledServer,
    subscribed,
    permission,
    busy,
    loading,
    statusMessage,
    enablePush,
    disablePush,
  } = usePushNotifications();

  const handleToggle = async (checked: boolean) => {
    try {
      if (checked) {
        await enablePush();
        toast.success("Push alerts enabled", {
          description: "You will get lock-screen notifications for new orders and customers.",
        });
      } else {
        await disablePush();
        toast.success("Push alerts turned off");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update push notifications.");
    }
  };

  const disabled = loading || busy || !availableOnDevice || !pushEnabledServer || permission === "denied";

  return (
    <div className="card-float p-6 space-y-4 opacity-0 animate-fade-in" style={{ animationDelay: "165ms" }}>
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <BellRing className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-heading font-semibold text-foreground">Push alerts</h2>
          <p className="text-xs text-muted-foreground font-body mt-1">
            Get notified on this device when new orders or customers arrive — even when the CRM is in the background or closed (installed app or supported browser).
          </p>
        </div>
      </div>

      {statusMessage && (
        <div className="rounded-xl border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs text-muted-foreground font-body flex gap-2">
          <Smartphone className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <span>{statusMessage}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-foreground font-body">Device push notifications</p>
          <p className="text-xs text-muted-foreground font-body mt-0.5">
            {subscribed ? "Enabled on this device" : "Off on this device"}
            {permission === "granted" && !subscribed ? " · permission granted, finish enabling" : ""}
          </p>
        </div>
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <Switch checked={subscribed} disabled={disabled} onCheckedChange={(v) => void handleToggle(v)} />
        )}
      </div>

      {!subscribed && availableOnDevice && pushEnabledServer && permission !== "denied" && (
        <Button
          type="button"
          variant="outline"
          className="w-full rounded-xl font-body"
          disabled={busy}
          onClick={() => void handleToggle(true)}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Enable push on this device
        </Button>
      )}

      <p className="text-[11px] text-muted-foreground font-body">
        In-app alerts (bell icon) still work while you are signed in. Push uses the same rules: your assigned customers, plus managers and admins for team scope.
      </p>
    </div>
  );
}

/** Compact row for the notification popover. */
export function PushNotificationsToggleRow() {
  const { availableOnDevice, pushEnabledServer, subscribed, busy, loading, enablePush, disablePush, permission } =
    usePushNotifications();

  if (!availableOnDevice) return null;

  return (
    <div className="border-t px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground font-body">Push on this device</p>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <Switch
            checked={subscribed}
            disabled={busy || !pushEnabledServer || permission === "denied"}
            onCheckedChange={async (on) => {
              try {
                if (on) await enablePush();
                else await disablePush();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Push update failed");
              }
            }}
          />
        )}
      </div>
      {!pushEnabledServer && (
        <p className="text-[10px] text-muted-foreground font-body">Server push not configured.</p>
      )}
      <Link to="/profile" className="text-[10px] text-primary font-body hover:underline">
        Profile → push settings
      </Link>
    </div>
  );
}
