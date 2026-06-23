/**
 * No-op browser console in production builds so third-party libraries (Supabase,
 * Recharts, etc.) cannot leak implementation details in DevTools.
 * Import this module before any other app code in main.tsx.
 */
if (import.meta.env.PROD && typeof window !== "undefined") {
  const noop = () => undefined;
  const silentMethods = [
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
  ] as const;

  for (const method of silentMethods) {
    try {
      (console[method] as typeof noop) = noop;
    } catch {
      // Some environments make console methods non-writable.
    }
  }
}
