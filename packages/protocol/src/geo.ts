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
export const MAX_ACCEPTED_ACCURACY_M = 100;
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
}): GeofenceVerdict {
  const distanceM = distanceMeters(p.centerLat, p.centerLng, p.lat, p.lng);
  // Real GNSS never reports perfect accuracy; 0 is the classic fake-GPS signature.
  if (!(p.accuracyM > 0)) return { ok: false, reason: 'suspicious', distanceM };
  if (p.accuracyM > MAX_ACCEPTED_ACCURACY_M) return { ok: false, reason: 'imprecise', distanceM };
  const allowance = Math.min(p.accuracyM, GEOFENCE_JITTER_ALLOWANCE_M);
  if (distanceM > p.radiusM + allowance) return { ok: false, reason: 'outside', distanceM };
  return { ok: true, distanceM };
}
