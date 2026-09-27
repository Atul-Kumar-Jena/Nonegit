import { z } from 'zod';
import { StorageKeys, getJson, setJson } from './storage';

export const Prefs = z.object({
  /** Fingerprint / face / phone PIN before each scan. */
  biometricForScans: z.boolean().default(false),
  /** Fingerprint / face / phone PIN to open the app (and again after 30 s away). */
  appLock: z.boolean().default(false),
});
export type Prefs = z.infer<typeof Prefs>;

const DEFAULTS: Prefs = { biometricForScans: false, appLock: false };

export async function loadPrefs(): Promise<Prefs> {
  return (await getJson(StorageKeys.prefs, (v) => Prefs.parse(v))) ?? DEFAULTS;
}

/** Saves some preferences, keeping the others. */
export async function savePrefs(p: Partial<Prefs>): Promise<Prefs> {
  const next = { ...(await loadPrefs()), ...p };
  await setJson(StorageKeys.prefs, next);
  return next;
}
