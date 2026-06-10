import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type UserNotificationRow = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
};

export function useUnreadNotifications(limit = 30) {
  return useQuery({
    queryKey: ["user-notifications-unread", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_notifications")
        .select("*")
        .is("read_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as UserNotificationRow[];
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useRecentNotifications(limit = 50) {
  return useQuery({
    queryKey: ["user-notifications-recent", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as UserNotificationRow[];
    },
    staleTime: 30_000,
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (!ids.length) return 0;

      const { data: rpcData, error: rpcError } = await supabase.rpc("mark_user_notifications_read", { _ids: ids });
      if (!rpcError) {
        const updated = typeof rpcData === "number" ? rpcData : 0;
        if (updated === 0) throw new Error("No notifications were marked as read");
        return updated;
      }

      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from("user_notifications")
        .update({ read_at: now })
        .in("id", ids)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("No notifications were marked as read");
      return data.length;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["user-notifications-unread"] });
      void qc.invalidateQueries({ queryKey: ["user-notifications-recent"] });
    },
  });
}
