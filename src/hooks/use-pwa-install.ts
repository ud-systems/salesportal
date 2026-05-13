import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Chrome/Edge install prompt event. Not in lib.dom yet, so we type it locally.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

type PromptOutcome = "accepted" | "dismissed" | "unavailable";

function detectStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  // iOS Safari sets `navigator.standalone` when launched from the home screen.
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function detectIosSafari(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Mac") && "ontouchend" in document);
  if (!isIos) return false;
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isSafari;
}

/**
 * Captures the deferred install prompt and exposes a programmatic `promptInstall()`.
 *
 * - On Android/desktop Chromium: `canPrompt` becomes true when `beforeinstallprompt` fires.
 * - On iOS Safari: `canPrompt` stays false (the platform never fires the event), but
 *   `isIosSafari` is true so callers can render an instructional dialog instead.
 * - When the app is already installed (standalone display mode), `isInstalled` is true and
 *   callers should typically hide the install affordance.
 */
export function usePwaInstall() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState<boolean>(() => detectStandalone());

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };

    const handleInstalled = () => {
      setDeferred(null);
      setIsInstalled(true);
    };

    const standaloneMql = window.matchMedia?.("(display-mode: standalone)");
    const handleDisplayChange = (ev: MediaQueryListEvent) => setIsInstalled(ev.matches);

    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleInstalled);
    standaloneMql?.addEventListener?.("change", handleDisplayChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleInstalled);
      standaloneMql?.removeEventListener?.("change", handleDisplayChange);
    };
  }, []);

  const isIosSafari = useMemo(() => detectIosSafari(), []);
  const canPrompt = !!deferred && !isInstalled;

  const promptInstall = useCallback(async (): Promise<PromptOutcome> => {
    if (!deferred) return "unavailable";
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      setDeferred(null);
      return choice.outcome;
    } catch (err) {
      console.error("PWA install prompt failed", err);
      setDeferred(null);
      return "unavailable";
    }
  }, [deferred]);

  return {
    canPrompt,
    isInstalled,
    isIosSafari,
    promptInstall,
  };
}
