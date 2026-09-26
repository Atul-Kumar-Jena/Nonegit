import { z } from 'zod';
import { StorageKeys, getJson, setJson } from './storage';

export const Prefs = z.object({ biometricForScans: z.boolean().default(false) });
export type Prefs = z.infer<typeof Prefs>;

export async function loadPrefs(): Promise<Prefs> {
  return (await getJson(StorageKeys.prefs, (v) => Prefs.parse(v))) ?? { biometricForScans: false };
}

export async function savePrefs(p: Prefs): Promise<void> {
  await setJson(StorageKeys.prefs, p);
}
