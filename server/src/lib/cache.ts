/**
 * A tiny in-memory cache for heavy, read-only reports: many staff opening Today / Reports at the
 * same moment get one computation instead of one each. Short-lived (seconds), bounded in size,
 * and concurrent callers share the same in-flight promise.
 */
export function ttlCache<T>(ttlMs: number, max = 300) {
  const store = new Map<string, { at: number; value: Promise<T> }>();
  return async (key: string, now: number, compute: () => Promise<T>): Promise<T> => {
    const hit = store.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    const value = compute();
    store.set(key, { at: now, value });
    value.catch(() => store.delete(key)); // never cache a failure
    if (store.size > max) for (const k of [...store.keys()].slice(0, store.size - max)) store.delete(k);
    return value;
  };
}
