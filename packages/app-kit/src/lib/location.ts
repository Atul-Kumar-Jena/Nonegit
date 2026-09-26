import { Platform } from 'react-native';
import * as Location from 'expo-location';

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
