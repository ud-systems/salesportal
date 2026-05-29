import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { invalidateAllAppQueries } from "@/lib/client-cache";

/** Reloads live data and the current user session without a full browser refresh. */
export function SidebarRefreshButton() {
  const { user, refreshSessionUser } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  if (!user?.hasDbRole) return null;

  const handleRefresh = async () => {
    setBusy(true);
    try {
      await refreshSessionUser();
      await invalidateAllAppQueries(queryClient);
      toast.success("Data refreshed", {
        description: "Dashboard and lists are loading the latest numbers from the server.",
      });
    } catch {
      toast.error("Could not refresh. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={() => void handleRefresh()}
      className="w-full justify-start gap-2 rounded-xl font-body text-xs"
      aria-label="Refresh dashboard data"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
      Refresh data
    </Button>
  );
}
