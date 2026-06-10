import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  useMarkNotificationsRead,
  useUnreadNotifications,
  type UserNotificationRow,
} from "@/hooks/use-notifications";
import { formatDisplayDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { PushNotificationsToggleRow } from "@/components/PushNotificationsCard";

function toastForNotification(n: UserNotificationRow) {
  const description = n.body ?? undefined;
  if (n.type === "new_order") {
    toast.success(n.title, { description, duration: 8000 });
    return;
  }
  if (n.type === "new_customer") {
    toast.info(n.title, { description, duration: 6000 });
    return;
  }
  toast.message(n.title, { description });
}

export function NotificationBell({ className }: { className?: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: unread = [] } = useUnreadNotifications(25);
  const markRead = useMarkNotificationsRead();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user?.id || !user.hasDbRole) return;

    const channel = supabase
      .channel(`user-notifications-live-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "user_notifications",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as UserNotificationRow;
          void qc.invalidateQueries({ queryKey: ["user-notifications-unread"] });
          void qc.invalidateQueries({ queryKey: ["user-notifications-recent"] });
          toastForNotification(row);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user?.id, user?.hasDbRole, qc]);

  if (!user?.hasDbRole) return null;

  const openEntity = (n: UserNotificationRow) => {
    if (n.entity_type === "order" && n.entity_id) {
      navigate(`/orders?orderId=${encodeURIComponent(n.entity_id)}`);
      setOpen(false);
      return;
    }
    if (n.entity_type === "customer" && n.entity_id) {
      navigate("/customers");
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn("relative h-10 w-10 rounded-xl shrink-0", className)}
          aria-label={`Notifications${unread.length ? `, ${unread.length} unread` : ""}`}
        >
          <Bell className="h-4 w-4" />
          {unread.length > 0 && (
            <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
              {unread.length > 9 ? "9+" : unread.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(100vw-2rem,360px)] p-0 rounded-2xl z-[100]">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="font-heading font-semibold text-sm text-foreground">Notifications</p>
          {unread.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-lg text-xs font-body"
              disabled={markRead.isPending}
              onClick={() =>
                void markRead.mutateAsync(unread.map((n) => n.id)).catch(() => {
                  toast.error("Could not mark notifications as read. Please try again.");
                })
              }
            >
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-[min(50vh,320px)] overflow-y-auto">
          {unread.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground font-body">No unread notifications.</p>
          ) : (
            <ul className="py-2 font-body text-sm">
              {unread.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className="w-full text-left px-4 py-2.5 hover:bg-muted/60 transition-colors"
                    onClick={() => openEntity(n)}
                  >
                    <p className="font-semibold text-foreground">{n.title}</p>
                    {n.body && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>}
                    <p className="text-[10px] text-muted-foreground mt-1">{formatDisplayDateTime(n.created_at)}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <PushNotificationsToggleRow />
      </PopoverContent>
    </Popover>
  );
}
