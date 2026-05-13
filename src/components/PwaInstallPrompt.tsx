import { useState } from "react";
import { Download, Share, Plus, SquarePlus, X, Monitor, Sparkles, Wifi, Smartphone } from "lucide-react";
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
 * Sidebar CTA + branded preview dialog for installing the CRM as a standalone app.
 *
 * Flow:
 *   Click "Install app" → branded preview dialog (logo, screenshot, benefits)
 *     → "Install now" → calls `deferred.prompt()` → browser's native confirm dialog
 *
 * The browser's final confirmation cannot be replaced (security: the user must confirm
 * install in the user agent's own UI). Everything *before* it is fully in-app.
 *
 * Per-platform behavior:
 * - Android / Chromium desktop: branded preview → native prompt.
 * - iOS Safari: branded preview → Share / Add to Home Screen instructions (iOS never
 *   fires `beforeinstallprompt`).
 * - Other browsers w/o a deferred prompt: branded preview → fallback instructions
 *   (address bar / browser menu).
 * - When already installed (standalone display mode): hidden.
 */
export function PwaInstallPrompt() {
  const { canPrompt, isInstalled, isIosSafari, promptInstall } = usePwaInstall();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [iosOpen, setIosOpen] = useState(false);
  const [chromiumOpen, setChromiumOpen] = useState(false);
  const isDev = import.meta.env.DEV;

  if (isInstalled) return null;

  const handleConfirmInstall = async () => {
    if (canPrompt) {
      const outcome = await promptInstall();
      setPreviewOpen(false);
      if (outcome === "accepted") {
        toast.success("Installing UD CRM", { description: "Look for the app icon on your home screen." });
      }
      return;
    }
    setPreviewOpen(false);
    if (isIosSafari) {
      setIosOpen(true);
      return;
    }
    setChromiumOpen(true);
  };

  return (
    <>
      <Button
        size="sm"
        onClick={() => setPreviewOpen(true)}
        className="w-full justify-start gap-2 rounded-xl font-body text-xs bg-black text-white border border-black hover:bg-accent hover:text-accent-foreground hover:border-input"
        aria-label="Install UD CRM as an app"
      >
        <Download className="h-4 w-4" aria-hidden />
        Install app
      </Button>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden rounded-2xl">
          <DialogHeader className="p-4 pb-3 pr-12 space-y-1">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-2xl gradient-primary flex items-center justify-center shadow-sm">
                <img src="/white logo.png" alt="" className="h-6 w-6 object-contain" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <DialogTitle className="font-heading text-base text-left truncate">Unique Distribution CRM</DialogTitle>
                <DialogDescription className="text-left text-xs">
                  Install for one-tap access from your home screen or desktop.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="border-t border-border bg-muted/30 px-4 py-3">
            <div className="aspect-[16/9] w-full overflow-hidden rounded-xl border border-border bg-background">
              <img
                src="/pwa-screenshot-wide.png"
                alt="Preview of Unique Distribution CRM"
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </div>
          </div>

          <ul className="px-4 py-3 space-y-2 font-body text-xs border-y border-border">
            <li className="flex items-start gap-2.5">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span className="flex-1">Launches in its own window — no browser tabs or address bar.</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span className="flex-1">Pinned to your home screen / dock for instant access.</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Wifi className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span className="flex-1">Loads the app shell instantly, even on flaky connections.</span>
            </li>
          </ul>

          <DialogFooter className="p-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button variant="outline" className="rounded-xl w-full sm:w-auto" aria-label="Cancel install">
                <X className="mr-1 h-4 w-4" aria-hidden /> Cancel
              </Button>
            </DialogClose>
            <Button
              className="rounded-xl w-full sm:w-auto bg-black text-white border border-black hover:bg-accent hover:text-accent-foreground hover:border-input"
              onClick={() => void handleConfirmInstall()}
            >
              <Download className="mr-1 h-4 w-4" aria-hidden />
              Install now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <Dialog open={chromiumOpen} onOpenChange={setChromiumOpen}>
        <DialogContent className="sm:max-w-md p-0 gap-0 overflow-hidden rounded-2xl">
          <DialogHeader className="p-4 pb-2 pr-12 space-y-1">
            <DialogTitle className="font-heading text-left text-base">Install on desktop or Android</DialogTitle>
            <DialogDescription className="text-left text-sm">
              Use <span className="font-semibold">Chrome</span> or <span className="font-semibold">Edge</span> and try
              the steps below. The install icon can take a moment to appear after the service worker registers.
            </DialogDescription>
          </DialogHeader>

          <div className="px-4 py-3 space-y-3 font-body text-sm border-y border-border text-left">
            {isDev && (
              <p className="rounded-xl border border-border bg-muted/50 px-3 py-2 text-xs leading-relaxed">
                You are on the <span className="font-semibold">Vite dev server</span>. A dev service worker is enabled so
                install can work on localhost after it registers. If you still never see an install icon, run{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px]">npm run build</code> then{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px]">npm run preview</code> and open the preview
                URL (install behaves like production).
              </p>
            )}
            <ul className="space-y-2.5">
              <li className="flex gap-3">
                <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                  <Monitor className="h-4 w-4" aria-hidden />
                </span>
                <span>
                  In <span className="font-semibold">Chrome</span> or <span className="font-semibold">Edge</span>, check
                  the <span className="font-semibold">right side of the address bar</span> for an install icon (⊕ or
                  monitor with arrow). It may appear only after the page has fully loaded once or twice.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground font-semibold text-xs">
                  ⋮
                </span>
                <span>
                  Or open the browser <span className="font-semibold">menu</span> (⋮) → look for{" "}
                  <span className="font-semibold">Install Unique Distribution CRM…</span>,{" "}
                  <span className="font-semibold">Install app</span>, or{" "}
                  <span className="font-semibold">Save and share → Install page as app</span> (wording varies by
                  version).
                </span>
              </li>
            </ul>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Production sites must be served over <span className="font-semibold">HTTPS</span>. Firefox does not
              support the same install flow; use Chrome or Edge for a one-tap install.
            </p>
          </div>

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
