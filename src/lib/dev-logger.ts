const isDev = import.meta.env.DEV;

export function devError(...args: unknown[]) {
  if (!isDev) return;
  console.error(...args);
}

export function devWarn(...args: unknown[]) {
  if (!isDev) return;
  console.warn(...args);
}

export function devInfo(...args: unknown[]) {
  if (!isDev) return;
  console.info(...args);
}
