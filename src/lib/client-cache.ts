import type { QueryClient } from "@tanstack/react-query";

/** Marks all TanStack Query caches stale and refetches active queries (dashboards, orders, etc.). */
export async function invalidateAllAppQueries(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries();
}

/** Removes saved dashboard filter presets for one user from localStorage (`filters:*:userId`). */
export function clearUserFilterPresetsLocal(userId: string): void {
  if (typeof window === "undefined" || !userId) return;
  try {
    const prefix = `filters:`;
    const suffix = `:${userId}`;
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(prefix) && k.endsWith(suffix)) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    // no-op
  }
}
