/**
 * Optional screenshot blocking (staff apps). Off by default so people can capture bugs;
 * turning it on also hides the app's content in the app switcher. Saved on this phone.
 */
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { vault } from './vault';

type ScreenCaptureModule = typeof import('expo-screen-capture');
/**
 * Loaded on first use, never at start-up: an app built without the native module (a missing
 * dependency) must still open instead of crashing on launch.
 */
function screenCapture(): ScreenCaptureModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-screen-capture') as ScreenCaptureModule;
  } catch {
    return null;
  }
}

const KEY = 'privacy.block-screenshots.v1';
let blocked = false;
const listeners = new Set<() => void>();

async function apply(on: boolean) {
  if (Platform.OS === 'web') return;
  const ScreenCapture = screenCapture();
  if (!ScreenCapture) return;
  try {
    if (on) {
      await ScreenCapture.preventScreenCaptureAsync('attendly');
      await ScreenCapture.enableAppSwitcherProtectionAsync(0.9);
    } else {
      await ScreenCapture.allowScreenCaptureAsync('attendly');
      await ScreenCapture.disableAppSwitcherProtectionAsync();
    }
  } catch {
    // best effort
  }
}

/** Reads the saved choice and applies it (call once at startup). */
export async function loadScreenshotSetting(): Promise<void> {
  try {
    blocked = (await vault.get<boolean>(KEY, (v) => v === true)) ?? false;
  } catch {
    blocked = false;
  }
  await apply(blocked);
  listeners.forEach((l) => l());
}

export async function setScreenshotsBlocked(on: boolean): Promise<void> {
  blocked = on;
  listeners.forEach((l) => l());
  await apply(on);
  await vault.set(KEY, on).catch(() => undefined);
}

export function useScreenshotsBlocked(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => blocked,
  );
}
