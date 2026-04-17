import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useUnreadNotifications, useMarkNotificationsRead } from "@/hooks/use-notifications";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatDisplayDateTime } from "@/lib/format";

const SESSION_KEY = "uddash_notifications_dialog_seen";

export function PostLoginNotifications() {
  const { user, loading } = useAuth();
  const { data: unread = [], isSuccess } = useUnreadNotifications(25);
  const markRead = useMarkNotificationsRead();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (loading || !user?.hasDbRole) return;
    if (!isSuccess || unread.length === 0) return;
    const sessionId = `${user.id}:${unread.map((n) => n.id).join(",")}`;
    const last = sessionStorage.getItem(SESSION_KEY);
    if (last === sessionId) return;
    setOpen(true);
  }, [loading, user?.id, user?.hasDbRole, isSuccess, unread]);

  const handleDismiss = async (markAsRead: boolean) => {
    const sessionId = `${user?.id}:${unread.map((n) => n.id).join(",")}`;
    sessionStorage.setItem(SESSION_KEY, sessionId);
    if (markAsRead && unread.length) {
      await markRead.mutateAsync(unread.map((n) => n.id));
    }
    setOpen(false);
  };

  if (!user?.hasDbRole) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && void handleDismiss(false)}>
      <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden rounded-2xl">
        <DialogHeader className="p-4 pb-2 pr-12 space-y-1 relative">
          <DialogTitle className="font-heading text-left">New activity</DialogTitle>
          <DialogDescription className="text-left text-sm">
            {unread.length} unread notification{unread.length === 1 ? "" : "s"} for your account.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(50vh,320px)] overflow-y-auto px-4 border-y border-border">
          <ul className="py-2 space-y-2 font-body text-sm">
            {unread.map((n) => (
              <li key={n.id} className="rounded-xl border bg-muted/40 px-3 py-2">
                <p className="font-semibold text-foreground">{n.title}</p>
                {n.body && <p className="text-muted-foreground text-xs mt-0.5">{n.body}</p>}
                <p className="text-[10px] text-muted-foreground mt-1">{formatDisplayDateTime(n.created_at)}</p>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter className="p-4 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <Button type="button" variant="outline" className="rounded-xl w-full sm:w-auto" onClick={() => void handleDismiss(false)}>
            Close
          </Button>
          <Button
            type="button"
            className="rounded-xl w-full sm:w-auto"
            disabled={markRead.isPending || unread.length === 0}
            onClick={() => void handleDismiss(true)}
          >
            Mark all read
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
