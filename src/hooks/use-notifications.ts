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
      if (!ids.length) return;
      const now = new Date().toISOString();
      const { error } = await supabase.from("user_notifications").update({ read_at: now }).in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["user-notifications-unread"] });
      void qc.invalidateQueries({ queryKey: ["user-notifications-recent"] });
    },
  });
}
