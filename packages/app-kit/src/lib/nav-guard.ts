/**
 * Fast double/triple taps used to open the same screen two or three times. Every
 * router.push in the apps goes through this guard: the same destination within a second,
 * or any second push within 350 ms of the last, is ignored.
 */
import { router } from 'expo-router';

let installed = false;

export function installNavigationGuard(): void {
  if (installed) return;
  installed = true;
  const r = router as unknown as Record<string, (...args: unknown[]) => unknown>;
  let last = { key: '', at: 0 };
  for (const name of ['push', 'navigate'] as const) {
    const original = r[name];
    if (typeof original !== 'function') continue;
    r[name] = (...args: unknown[]) => {
      const key = (() => {
        try {
          return JSON.stringify(args[0]);
        } catch {
          return String(args[0]);
        }
      })();
      const now = Date.now();
      if ((key === last.key && now - last.at < 1000) || now - last.at < 350) return undefined;
      last = { key, at: now };
      return original.apply(router, args);
    };
  }
}
