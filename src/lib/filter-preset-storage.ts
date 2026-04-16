export function loadUserFilterPreset<T>(userId: string | undefined, pageKey: string, fallback: T): T {
  if (!userId || typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(`filters:${pageKey}:${userId}`);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

export function saveUserFilterPreset<T>(userId: string | undefined, pageKey: string, value: T): void {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`filters:${pageKey}:${userId}`, JSON.stringify(value));
  } catch {
    // no-op
  }
}
