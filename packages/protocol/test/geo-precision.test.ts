import { describe, expect, it } from 'vitest';
import {
  distanceMeters,
  evaluateGeofence,
  fuseSamples,
  maxUnexplainedSpeed,
  samplesForScan,
  GEO_SAMPLE_WINDOW_MS,
  MAX_GEO_SAMPLES,
  TELEPORT_MIN_M,
  TELEPORT_SPEED_MPS,
  type GeoSample,
} from '../src/geo';

const C = { lat: 28.545, lng: 77.1926 };
/** A point `north` metres north and `east` metres east of C. */
const p = (north: number, east = 0) => ({ lat: C.lat + north / 111_195, lng: C.lng + east / (111_195 * Math.cos((C.lat * Math.PI) / 180)) });
const s = (north: number, accuracyM: number, t: number, east = 0): GeoSample => ({ ...p(north, east), accuracyM, t });

describe('fusing several fixes', () => {
  it('averages the fixes that agree, weighted by precision, and keeps the best accuracy', () => {
    const f = fuseSamples([s(10, 20, 1000), s(4, 6, 2000), s(6, 6, 3000), s(5, 8, 4000)])!;
    expect(f.accuracyM).toBe(6);
    expect(f.used).toBe(3); // the ±20 m fix is too coarse next to ±6 m ones
    expect(distanceMeters(C.lat, C.lng, f.lat, f.lng)).toBeGreaterThan(4.5);
    expect(distanceMeters(C.lat, C.lng, f.lat, f.lng)).toBeLessThan(5.6);
    expect(f.t).toBe(4000);
  });

  it('drops a fix that disagrees (a multipath jump or a stale network fix) instead of averaging it in', () => {
    const f = fuseSamples([s(5, 8, 1000), s(6, 8, 2000), s(90, 9, 3000)])!;
    expect(f.used).toBe(2);
    expect(distanceMeters(C.lat, C.lng, f.lat, f.lng)).toBeLessThan(7);
  });

  it('ignores invalid fixes; none valid → null', () => {
    expect(fuseSamples([{ lat: 999, lng: 0, accuracyM: 5, t: 1 }, s(0, 0, 2)])).toBeNull();
    expect(fuseSamples([])).toBeNull();
    expect(fuseSamples([s(3, 0, 1), s(4, 10, 2)])!.used).toBe(1);
  });
});

describe('spotting fake locations inside one scan', () => {
  it('normal indoor jitter is explained by the fixes’ uncertainty', () => {
    expect(maxUnexplainedSpeed([s(0, 15, 0), s(25, 15, 1000), s(-5, 20, 2000)]).speedMps).toBe(0);
  });

  it('a spoofing app switched on mid-scan jumps kilometres in a second', () => {
    const j = maxUnexplainedSpeed([s(0, 10, 0), s(0, 10, 1000), s(0, 10, 2000, 12_000)]);
    expect(j.speedMps).toBeGreaterThan(TELEPORT_SPEED_MPS);
    expect(j.jumpM).toBeGreaterThan(TELEPORT_MIN_M);
  });

  it('walking between rooms is not flagged', () => {
    const j = maxUnexplainedSpeed([s(0, 5, 0), s(30, 5, 20_000)]);
    expect(j.speedMps).toBeLessThan(2);
  });
});

describe('choosing the fixes for a scan', () => {
  it('keeps the latest fixes within the window, oldest first', () => {
    const buf = Array.from({ length: 40 }, (_, i) => s(i % 3, 10, i * 1000));
    const picked = samplesForScan(buf, 39_000);
    expect(picked).toHaveLength(MAX_GEO_SAMPLES);
    expect(picked[0]!.t).toBe(28_000);
    expect(picked.at(-1)!.t).toBe(39_000);
    expect(samplesForScan(buf, 39_000 + GEO_SAMPLE_WINDOW_MS + 1)).toHaveLength(0);
  });
});

describe('geofence allowance', () => {
  it('adds a capped allowance for how precisely the classroom centre was measured', () => {
    const at = p(58);
    expect(evaluateGeofence({ centerLat: C.lat, centerLng: C.lng, radiusM: 50, ...at, accuracyM: 5 }).ok).toBe(false);
    expect(evaluateGeofence({ centerLat: C.lat, centerLng: C.lng, radiusM: 50, ...at, accuracyM: 5, centerAccuracyM: 4 }).ok).toBe(true);
    // A huge claimed centre inaccuracy still buys at most 10 m.
    expect(evaluateGeofence({ centerLat: C.lat, centerLng: C.lng, radiusM: 50, ...p(75), accuracyM: 10, centerAccuracyM: 500 }).ok).toBe(false);
    expect(evaluateGeofence({ centerLat: C.lat, centerLng: C.lng, radiusM: 50, ...at, accuracyM: 5, centerAccuracyM: 4, strict: true }).ok).toBe(false);
  });

  it('refuses fixes worse than ±75 m', () => {
    expect(evaluateGeofence({ centerLat: C.lat, centerLng: C.lng, radiusM: 50, ...p(0), accuracyM: 80 })).toMatchObject({ ok: false, reason: 'imprecise' });
  });
});
