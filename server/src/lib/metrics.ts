/** In-memory request metrics for the developer console (per server instance, since start). */
const SIZE = 2000;
const durations = new Float64Array(SIZE);
let n = 0;
let total = 0;
let errors5xx = 0;
export const startedAt = Date.now();

export function recordRequest(ms: number, status: number): void {
  durations[n % SIZE] = ms;
  n++;
  total++;
  if (status >= 500) errors5xx++;
}

export function requestStats(): { requests: number; errors5xx: number; p50Ms: number | null; p99Ms: number | null; uptimeSec: number } {
  const count = Math.min(n, SIZE);
  const sorted = Array.from(durations.subarray(0, count)).sort((a, b) => a - b);
  const pick = (q: number) => (count ? Math.round(sorted[Math.min(count - 1, Math.floor(q * count))]! * 10) / 10 : null);
  return { requests: total, errors5xx, p50Ms: pick(0.5), p99Ms: pick(0.99), uptimeSec: Math.round((Date.now() - startedAt) / 1000) };
}
