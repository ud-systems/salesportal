/**
 * Silence browser console output on production hosts before app code runs.
 * Import first in main.tsx; index.html also runs an inline copy before the bundle.
 *
 * Limits: Chrome DevTools Network tab and native WebSocket failure lines are logged by
 * the browser itself — JS cannot remove those. The Supabase publishable key is also
 * intentionally public in every SPA request; RLS protects data, not key secrecy.
 */

function isLocalDevHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function isProductionRuntime() {
  if (typeof window === "undefined") return import.meta.env.PROD;
  return import.meta.env.PROD || !isLocalDevHost(window.location.hostname);
}

export function installProductionConsoleGuard() {
  if (!isProductionRuntime() || typeof window === "undefined") return;
  if ((window as Window & { __udConsoleGuardInstalled?: boolean }).__udConsoleGuardInstalled) return;
  (window as Window & { __udConsoleGuardInstalled?: boolean }).__udConsoleGuardInstalled = true;

  const noop = () => undefined;
  const methods = [
    "log",
    "debug",
    "info",
    "warn",
    "error",
    "trace",
    "group",
    "groupCollapsed",
    "groupEnd",
    "table",
    "dir",
    "dirxml",
    "assert",
  ] as const;

  for (const method of methods) {
    try {
      (console[method] as typeof noop) = noop;
    } catch {
      // Some environments make console methods non-writable.
    }
  }

  window.addEventListener(
    "error",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      return false;
    },
    true,
  );

  window.addEventListener(
    "unhandledrejection",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}

installProductionConsoleGuard();
