import { Platform } from 'react-native';
import * as Location from 'expo-location';
import { GEO_SAMPLE_WINDOW_MS, GOOD_FIX_M, fuseSamples, type GeoSample } from '@attendly/protocol';

export interface LocationFix {
  lat: number;
  lng: number;
  accuracyM: number;
  mocked: boolean;
  /** Device-clock time of the fix. */
  timestamp: number;
}

export type LocationProblem = 'permission-denied' | 'services-off' | 'timeout' | 'unavailable';

export class LocationError extends Error {
  constructor(
    readonly problem: LocationProblem,
    message: string,
  ) {
    super(message);
  }
}

export async function ensureLocationPermission(): Promise<'granted' | 'denied' | 'blocked'> {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.granted) return 'granted';
  if (!current.canAskAgain) return 'blocked';
  const asked = await Location.requestForegroundPermissionsAsync();
  return asked.granted ? 'granted' : asked.canAskAgain ? 'denied' : 'blocked';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new LocationError('timeout', 'Couldn’t get a GPS fix in time. Move near a window and try again.')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** A fresh, high-accuracy fix. Never returns a cached "last known" position. */
export async function getFreshFix(timeoutMs = 15_000): Promise<LocationFix> {
  const perm = await ensureLocationPermission();
  if (perm !== 'granted') throw new LocationError('permission-denied', 'Location permission is needed to prove you are in the classroom.');
  if (!(await Location.hasServicesEnabledAsync())) throw new LocationError('services-off', 'Turn on Location (GPS) to mark attendance.');
  try {
    // expo-location's web shim accepts cached positions of any age (maximumAge: Infinity);
    // on the web we ask the browser directly for a fresh fix instead.
    const pos =
      Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.geolocation
        ? await new Promise<{ coords: GeolocationCoordinates; timestamp: number; mocked?: boolean }>((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs }),
          )
        : await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest, mayShowUserSettingsDialog: true }), timeoutMs);
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracyM: pos.coords.accuracy ?? 9_999,
      mocked: pos.mocked === true,
      timestamp: pos.timestamp,
    };
  } catch (err) {
    if (err instanceof LocationError) throw err;
    throw new LocationError('unavailable', 'Location is unavailable right now. Try again in a moment.');
  }
}

export async function locationStatus(): Promise<'ready' | 'permission' | 'off'> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) return 'permission';
    return (await Location.hasServicesEnabledAsync()) ? 'ready' : 'off';
  } catch {
    return 'off';
  }
}

// ───────────────────────────── continuous fixes → precise position ─────────────────────────────

/**
 * Streams GPS fixes while a screen needs them (the scanner, starting a class, saving a room).
 * A scan then uses the fixes of the last seconds at once — no wait — and several fixes beat one:
 * the server fuses them and checks they agree (see fuseSamples in the protocol).
 */
export interface LocationStream {
  /** All fixes so far (device-clock times). */
  samples(): LocationFix[];
  /**
   * Resolves once there are `minSamples` fixes and the best is within `goodM` metres, or after
   * `maxWaitMs` with whatever arrived (at least one). Rejects when no fix arrives in `timeoutMs`.
   */
  settle(o?: { minSamples?: number; goodM?: number; maxWaitMs?: number; timeoutMs?: number }): Promise<LocationFix[]>;
  stop(): void;
}

const MAX_BUFFER = 60;

export async function startLocationStream(): Promise<LocationStream> {
  const perm = await ensureLocationPermission();
  if (perm !== 'granted') throw new LocationError('permission-denied', 'Location permission is needed to prove you are in the classroom.');
  if (!(await Location.hasServicesEnabledAsync())) throw new LocationError('services-off', 'Turn on Location (GPS) to mark attendance.');
  const buf: LocationFix[] = [];
  const waiters = new Set<() => void>();
  let failure: LocationError | null = null;
  const push = (f: LocationFix) => {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return;
    // The same fix delivered twice adds nothing.
    const last = buf[buf.length - 1];
    if (last && last.timestamp === f.timestamp && last.lat === f.lat && last.lng === f.lng) return;
    buf.push(f);
    if (buf.length > MAX_BUFFER) buf.shift();
    for (const w of waiters) w();
  };
  let stopNative: () => void = () => undefined;
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.geolocation) {
    const id = navigator.geolocation.watchPosition(
      (pos) => push({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? 9_999, mocked: false, timestamp: pos.timestamp }),
      () => {
        failure = new LocationError('unavailable', 'Location is unavailable right now. Try again in a moment.');
        for (const w of waiters) w();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
    stopNative = () => navigator.geolocation.clearWatch(id);
  } else {
    const sub = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1_000, distanceInterval: 0, mayShowUserSettingsDialog: true },
      (pos) =>
        push({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? 9_999,
          mocked: pos.mocked === true,
          timestamp: pos.timestamp,
        }),
    );
    stopNative = () => sub.remove();
  }
  let stopped = false;
  return {
    samples: () => [...buf],
    settle({ minSamples = 3, goodM = GOOD_FIX_M, maxWaitMs = 6_000, timeoutMs = 20_000 } = {}) {
      const started = Date.now();
      return new Promise<LocationFix[]>((resolve, reject) => {
        let done = false;
        const recent = () => buf.filter((f) => Date.now() - f.timestamp <= GEO_SAMPLE_WINDOW_MS);
        const finish = (err?: LocationError) => {
          if (done) return;
          done = true;
          waiters.delete(check);
          clearInterval(tick);
          if (err) reject(err);
          else resolve(recent());
        };
        const check = () => {
          if (failure && !buf.length) return finish(failure);
          const r = recent();
          const best = r.reduce((m, f) => Math.min(m, f.accuracyM), Number.POSITIVE_INFINITY);
          const waited = Date.now() - started;
          if (r.length >= minSamples && best <= goodM) return finish();
          if (r.length && waited >= maxWaitMs) return finish();
          if (!r.length && waited >= timeoutMs) finish(new LocationError('timeout', 'Couldn’t get a GPS fix in time. Move near a window and try again.'));
        };
        const tick = setInterval(check, 250);
        waiters.add(check);
        check();
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stopNative();
    },
  };
}

/** Converts fixes to the scan's wire format, on the server's clock. */
export function toWireSamples(fixes: readonly LocationFix[], clockOffsetMs: number): GeoSample[] {
  return fixes.map((f) => ({
    lat: f.lat,
    lng: f.lng,
    accuracyM: Math.max(0, f.accuracyM),
    t: Math.round(f.timestamp + clockOffsetMs),
    ...(f.mocked ? { mocked: true } : {}),
  }));
}

/**
 * A precise one-off position (starting a class, saving a room's centre): streams for a few seconds and
 * fuses the fixes. `accuracyM` is how precisely the centre is known.
 */
export async function getPreciseFix(o: { maxWaitMs?: number; timeoutMs?: number } = {}): Promise<LocationFix & { samples: number }> {
  const stream = await startLocationStream();
  try {
    const fixes = await stream.settle({ minSamples: 5, goodM: 8, maxWaitMs: o.maxWaitMs ?? 8_000, timeoutMs: o.timeoutMs ?? 25_000 });
    const fused = fuseSamples(fixes.map((f) => ({ lat: f.lat, lng: f.lng, accuracyM: f.accuracyM, t: f.timestamp })));
    if (!fused) throw new LocationError('unavailable', 'Location is unavailable right now. Try again in a moment.');
    return { lat: fused.lat, lng: fused.lng, accuracyM: fused.accuracyM, mocked: fixes.some((f) => f.mocked), timestamp: fused.t, samples: fused.used };
  } finally {
    stream.stop();
  }
}
