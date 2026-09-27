/**
 * In-memory abuse guard (per server instance), on top of the per-IP limiter:
 *  • each phone gets its own request budget, so one runaway or scripted phone can't hog the server;
 *  • an IP that keeps presenting bad signatures, replayed nonces or unknown tokens (someone probing or
 *    brute-forcing) is shut out for a while.
 */
export const DEVICE_MAX_PER_MIN = 240;
export const IP_FAILURES_TO_BLOCK = 60;
export const IP_FAILURE_WINDOW_MS = 10 * 60_000;
export const IP_BLOCK_MS = 15 * 60_000;
/** Responses that mean "this request wasn't from a genuine, signed-in phone". */
export const PROBE_CODES: ReadonlySet<string> = new Set(['BAD_SIGNATURE', 'REPLAY', 'UNAUTHENTICATED', 'TICKET_INVALID']);

export interface RequestGuard {
  /** False when this phone is over its per-minute budget. */
  deviceAllowed(deviceId: string, now: number): boolean;
  /** Milliseconds this IP is still blocked for (0 = not blocked). */
  ipBlockedFor(ip: string, now: number): number;
  recordProbe(ip: string, now: number): void;
}

export function createGuard(enabled = true): RequestGuard {
  const devices = new Map<string, { start: number; n: number }>();
  const probes = new Map<string, number[]>();
  const blocked = new Map<string, number>();
  let lastSweep = 0;
  const sweep = (now: number) => {
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    for (const [k, v] of devices) if (now - v.start > 60_000) devices.delete(k);
    for (const [k, v] of blocked) if (v <= now) blocked.delete(k);
    for (const [k, v] of probes) if (!v.length || now - v[v.length - 1]! > IP_FAILURE_WINDOW_MS) probes.delete(k);
  };
  return {
    deviceAllowed(deviceId, now) {
      if (!enabled) return true;
      sweep(now);
      const d = devices.get(deviceId);
      if (!d || now - d.start >= 60_000) {
        devices.set(deviceId, { start: now, n: 1 });
        return true;
      }
      d.n++;
      return d.n <= DEVICE_MAX_PER_MIN;
    },
    ipBlockedFor(ip, now) {
      if (!enabled) return 0;
      const until = blocked.get(ip);
      return until && until > now ? until - now : 0;
    },
    recordProbe(ip, now) {
      if (!enabled) return;
      const list = (probes.get(ip) ?? []).filter((t) => now - t < IP_FAILURE_WINDOW_MS);
      list.push(now);
      probes.set(ip, list);
      if (list.length >= IP_FAILURES_TO_BLOCK) {
        blocked.set(ip, now + IP_BLOCK_MS);
        probes.delete(ip);
      }
    },
  };
}
