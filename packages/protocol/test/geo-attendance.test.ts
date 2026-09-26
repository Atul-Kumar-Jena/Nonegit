import { describe, expect, it } from 'vitest';
import {
  attendancePercent,
  distanceMeters,
  evaluateGeofence,
  isValidLatLng,
  sessionsNeededToReach,
  sessionsSafeToMiss,
  standing,
} from '../src';

describe('geo', () => {
  it('distance is accurate for known points', () => {
    // ~111.2 km per degree of latitude
    expect(distanceMeters(0, 0, 1, 0)).toBeCloseTo(111_195, -2);
    expect(distanceMeters(28.5449, 77.1926, 28.5449, 77.1926)).toBe(0);
    // 50 m north
    expect(distanceMeters(28.5449, 77.1926, 28.5449 + 50 / 111_195, 77.1926)).toBeCloseTo(50, 0);
  });

  it('validates coordinates', () => {
    expect(isValidLatLng(10, 10)).toBe(true);
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(NaN, 0)).toBe(false);
    expect(isValidLatLng('1', 0)).toBe(false);
  });

  it('evaluates geofence with capped jitter allowance', () => {
    const c = { centerLat: 28.5449, centerLng: 77.1926, radiusM: 50 };
    const at = (m: number) => 28.5449 + m / 111_195;
    expect(evaluateGeofence({ ...c, lat: at(40), lng: 77.1926, accuracyM: 5 }).ok).toBe(true);
    expect(evaluateGeofence({ ...c, lat: at(58), lng: 77.1926, accuracyM: 20 }).ok).toBe(true); // 50 + 10 cap
    expect(evaluateGeofence({ ...c, lat: at(62), lng: 77.1926, accuracyM: 90 })).toMatchObject({ ok: false, reason: 'outside' });
    expect(evaluateGeofence({ ...c, lat: at(10), lng: 77.1926, accuracyM: 0 })).toMatchObject({ ok: false, reason: 'suspicious' });
    expect(evaluateGeofence({ ...c, lat: at(10), lng: 77.1926, accuracyM: 150 })).toMatchObject({ ok: false, reason: 'imprecise' });
  });
});

describe('attendance maths', () => {
  it('percent', () => {
    expect(attendancePercent(156, 179)).toBe(87.2);
    expect(attendancePercent(0, 0)).toBeNull();
    expect(attendancePercent(5, 4)).toBe(100);
  });

  it('sessions needed to reach 75%', () => {
    expect(sessionsNeededToReach(18, 25, 75)).toBe(3); // (18+3)/(25+3)=0.75
    expect(sessionsNeededToReach(3, 4, 75)).toBe(0);
    expect(sessionsNeededToReach(0, 4, 75)).toBe(12);
    for (let h = 1; h < 60; h++)
      for (let a = 0; a <= h; a++) {
        const y = sessionsNeededToReach(a, h, 75);
        expect((a + y) / (h + y)).toBeGreaterThanOrEqual(0.75 - 1e-12);
        if (y > 0) expect((a + y - 1) / (h + y - 1)).toBeLessThan(0.75);
      }
  });

  it('sessions safe to miss', () => {
    expect(sessionsSafeToMiss(24, 28, 75)).toBe(4); // 24/32 = .75
    expect(sessionsSafeToMiss(18, 25, 75)).toBe(0);
    for (let h = 1; h < 60; h++)
      for (let a = 0; a <= h; a++) {
        const x = sessionsSafeToMiss(a, h, 75);
        if (a / h >= 0.75) {
          expect(a / (h + x)).toBeGreaterThanOrEqual(0.75 - 1e-12);
          expect(a / (h + x + 1)).toBeLessThan(0.75);
        } else expect(x).toBe(0);
      }
  });

  it('standing', () => {
    expect(standing(0, 0, 75)).toBe('no-data');
    expect(standing(18, 25, 75)).toBe('at-risk');
    expect(standing(3, 4, 75)).toBe('safe');
  });
});

import { minToAttendOfNext } from '../src';
describe('planner', () => {
  it('minimum to attend of the next N', () => {
    expect(minToAttendOfNext(18, 25, 10, 75)).toBe(9); // (18+9)/35 = 77.1%, 8 → 74.3%
    expect(minToAttendOfNext(24, 28, 10, 75)).toBe(5); // 29/38 = 76.3%
    expect(minToAttendOfNext(0, 20, 5, 75)).toBe(19); // > 5 → unreachable
    for (let h = 0; h < 30; h++)
      for (let a = 0; a <= h; a++)
        for (const n of [1, 5, 12]) {
          const k = minToAttendOfNext(a, h, n, 75);
          if (k <= n) {
            expect((a + k) / (h + n)).toBeGreaterThanOrEqual(0.75 - 1e-12);
            if (k > 0) expect((a + k - 1) / (h + n)).toBeLessThan(0.75);
          }
        }
  });
});
