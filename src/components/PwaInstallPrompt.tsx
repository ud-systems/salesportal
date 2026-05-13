import { useState } from "react";
import { Download, Share, Plus, SquarePlus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePwaInstall } from "@/hooks/use-pwa-install";

/**
 * Sidebar CTA that installs the CRM as a standalone app.
 *
 * - On Android / Chromium desktop: triggers the deferred `beforeinstallprompt`.
 * - On iOS Safari: opens a small dialog with the Share -> "Add to Home Screen" steps,
 *   because iOS never fires `beforeinstallprompt`.
 * - On already-installed sessions: returns null (nothing to install).
 */
export function PwaInstallPrompt() {
  const { canPrompt, isInstalled, isIosSafari, promptInstall } = usePwaInstall();
  const [iosOpen, setIosOpen] = useState(false);

  if (isInstalled) return null;
  if (!canPrompt && !isIosSafari) return null;

  const handleClick = async () => {
    if (canPrompt) {
      const outcome = await promptInstall();
      if (outcome === "accepted") {
        toast.success("Installing UD CRM", { description: "Look for the app icon on your home screen." });
      }
      return;
    }
    setIosOpen(true);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleClick()}
        className="w-full justify-start gap-2 rounded-xl border-dashed font-body text-xs"
        aria-label="Install UD CRM as an app"
      >
        <Download className="h-4 w-4" aria-hidden />
        Install app
      </Button>

      <Dialog open={iosOpen} onOpenChange={setIosOpen}>
        <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden rounded-2xl">
          <DialogHeader className="p-4 pb-2 pr-12 space-y-1">
            <DialogTitle className="font-heading text-left text-base">Install on iPhone / iPad</DialogTitle>
            <DialogDescription className="text-left text-sm">
              Safari doesn&apos;t support one-tap install. Add the CRM in three steps:
            </DialogDescription>
          </DialogHeader>

          <ol className="px-4 py-3 space-y-3 font-body text-sm border-y border-border">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                <Share className="h-4 w-4" aria-hidden />
              </span>
              <span className="flex-1">
                Tap the <span className="font-semibold">Share</span> icon in Safari&apos;s toolbar.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                <SquarePlus className="h-4 w-4" aria-hidden />
              </span>
              <span className="flex-1">
                Scroll and tap <span className="font-semibold">Add to Home Screen</span>.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                <Plus className="h-4 w-4" aria-hidden />
              </span>
              <span className="flex-1">
                Confirm with <span className="font-semibold">Add</span>. The CRM appears on your home screen.
              </span>
            </li>
          </ol>

          <DialogFooter className="p-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button variant="outline" className="rounded-xl w-full sm:w-auto" aria-label="Close install instructions">
                <X className="mr-1 h-4 w-4" aria-hidden /> Close
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button className="rounded-xl w-full sm:w-auto">Got it</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
