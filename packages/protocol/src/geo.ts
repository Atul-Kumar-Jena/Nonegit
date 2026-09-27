/** Geodesy helpers for geofencing. */

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** Great-circle distance in metres (haversine; < 0.5% error, ample for geofences). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Location fixes worse than this are refused as too imprecise to prove presence. */
export const MAX_ACCEPTED_ACCURACY_M = 75;
/** Tolerance added to the radius to absorb normal GPS jitter. Capped, so a huge reported accuracy buys nothing. */
export const GEOFENCE_JITTER_ALLOWANCE_M = 10;
/** A location fix older than this (relative to the server clock) is stale. */
export const MAX_LOCATION_AGE_MS = 60_000;

export type GeofenceVerdict =
  | { ok: true; distanceM: number }
  | { ok: false; reason: 'imprecise' | 'outside' | 'suspicious'; distanceM: number };

export function evaluateGeofence(p: {
  centerLat: number;
  centerLng: number;
  radiusM: number;
  lat: number;
  lng: number;
  accuracyM: number;
  /** How precisely the classroom's centre itself was measured (averaged fixes), if known. */
  centerAccuracyM?: number | null;
  /** No ±accuracy allowance: the reported position itself must be inside the radius. */
  strict?: boolean;
}): GeofenceVerdict {
  const distanceM = distanceMeters(p.centerLat, p.centerLng, p.lat, p.lng);
  // Real GNSS never reports perfect accuracy; 0 is the classic fake-GPS signature.
  if (!(p.accuracyM > 0)) return { ok: false, reason: 'suspicious', distanceM };
  if (p.accuracyM > MAX_ACCEPTED_ACCURACY_M) return { ok: false, reason: 'imprecise', distanceM };
  // Both ends of the measurement jitter: the student's fix and the classroom centre — each capped,
  // so a large reported inaccuracy never widens the fence by more than a few metres.
  const allowance = p.strict
    ? 0
    : Math.min(p.accuracyM, GEOFENCE_JITTER_ALLOWANCE_M) + Math.min(Math.max(0, p.centerAccuracyM ?? 0), GEOFENCE_JITTER_ALLOWANCE_M);
  if (distanceM > p.radiusM + allowance) return { ok: false, reason: 'outside', distanceM };
  return { ok: true, distanceM };
}

// ───────────────────────────── several fixes → one precise position ─────────────────────────────

export interface GeoSample {
  lat: number;
  lng: number;
  accuracyM: number;
  /** When the fix was taken (server-corrected ms on the wire). */
  t: number;
  mocked?: boolean;
}

/** At most this many fixes accompany a scan. */
export const MAX_GEO_SAMPLES = 12;
/** Fixes older than this (before the scan) are not used for it. */
export const GEO_SAMPLE_WINDOW_MS = 30_000;
/** A reading this good ends the wait for more fixes. */
export const GOOD_FIX_M = 12;

export interface FusedFix {
  lat: number;
  lng: number;
  /** Never claimed better than the best single fix (GNSS errors are correlated over seconds). */
  accuracyM: number;
  t: number;
  used: number;
}

/**
 * Combines several fixes into one position: the best fix and the others that agree with it
 * (within both their uncertainties), averaged with weights 1/accuracy². Fixes that disagree
 * (multipath jumps, a stale network fix) are dropped rather than dragging the average.
 */
export function fuseSamples(samples: readonly GeoSample[]): FusedFix | null {
  const valid = samples.filter((s) => isValidLatLng(s.lat, s.lng) && s.accuracyM > 0 && Number.isFinite(s.accuracyM));
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => a.accuracyM - b.accuracyM);
  const best = sorted[0]!;
  const agree = sorted.filter(
    (s) => s.accuracyM <= Math.max(best.accuracyM * 2, best.accuracyM + 5) && distanceMeters(best.lat, best.lng, s.lat, s.lng) <= best.accuracyM + s.accuracyM,
  );
  let wSum = 0;
  let lat = 0;
  let lng = 0;
  for (const s of agree) {
    const w = 1 / (s.accuracyM * s.accuracyM);
    wSum += w;
    lat += s.lat * w;
    lng += s.lng * w;
  }
  return { lat: lat / wSum, lng: lng / wSum, accuracyM: best.accuracyM, t: Math.max(...agree.map((s) => s.t)), used: agree.length };
}

/**
 * The fastest movement between consecutive fixes that their uncertainties can't explain (m/s).
 * Real phones indoors jitter by tens of metres; a spoofing app switched on or off jumps kilometres.
 */
export function maxUnexplainedSpeed(samples: readonly GeoSample[]): { speedMps: number; jumpM: number } {
  const byTime = [...samples].sort((a, b) => a.t - b.t);
  let speedMps = 0;
  let jumpM = 0;
  for (let i = 1; i < byTime.length; i++) {
    const a = byTime[i - 1]!;
    const b = byTime[i]!;
    const excess = distanceMeters(a.lat, a.lng, b.lat, b.lng) - a.accuracyM - b.accuracyM;
    if (excess <= 0) continue;
    const dt = Math.max(1, (b.t - a.t) / 1000);
    if (excess / dt > speedMps) {
      speedMps = excess / dt;
      jumpM = excess;
    }
  }
  return { speedMps, jumpM };
}

/** Jumps faster than this over more than TELEPORT_MIN_M are treated as a faked location. */
export const TELEPORT_SPEED_MPS = 100;
export const TELEPORT_MIN_M = 150;
/** Between two scans: faster than ~250 km/h over more than 2 km is not a real journey. */
export const IMPOSSIBLE_TRAVEL_MPS = 70;
export const IMPOSSIBLE_TRAVEL_MIN_M = 2_000;

/** The fixes to send with a scan: the most recent ones inside the window, newest last. */
export function samplesForScan(buffer: readonly GeoSample[], scanAt: number): GeoSample[] {
  return buffer
    .filter((s) => s.t <= scanAt + 5_000 && scanAt - s.t <= GEO_SAMPLE_WINDOW_MS)
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_GEO_SAMPLES);
}
