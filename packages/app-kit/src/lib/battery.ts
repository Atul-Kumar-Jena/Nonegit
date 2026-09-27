/**
 * Android battery optimisation ("Doze") delays notifications and reminders by minutes or hours.
 * We ask Android to let the app run unrestricted — the system's own "Let app always run in
 * background?" dialog — so class changes and reminders arrive on time.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as Application from 'expo-application';
import type { PermState, PermissionItem } from './permissions';
import { openAppSettings } from './permissions';
import { vault } from './vault';

const KEY = 'battery.unrestricted.v1';
const DISMISS_KEY = 'battery.card.dismissed.v1';

/** Phones whose makers add their own "Autostart" / background limits on top of Android's. */
export const AGGRESSIVE_OEM = /xiaomi|redmi|poco|oppo|realme|vivo|iqoo|oneplus|huawei|honor|samsung|infinix|tecno/i;
export function brand(): string {
  const c = (Platform as unknown as { constants?: { Brand?: string; Manufacturer?: string } }).constants;
  return c?.Brand ?? c?.Manufacturer ?? '';
}

export async function batteryState(): Promise<PermState> {
  if (Platform.OS !== 'android') return 'unavailable';
  return (await vault.get<boolean>(KEY, (v) => v === true).catch(() => null)) ? 'granted' : 'denied';
}

/**
 * Shows Android's dialog. If the app is already unrestricted, Android answers "yes" at once
 * without showing anything, so this is also how we check.
 */
export async function requestBatteryExemption(): Promise<PermState> {
  if (Platform.OS !== 'android') return 'unavailable';
  const IL = await import('expo-intent-launcher');
  try {
    const r = await IL.startActivityAsync('android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS', { data: `package:${Application.applicationId}` });
    const ok = r.resultCode === IL.ResultCode.Success;
    if (ok) await vault.set(KEY, true).catch(() => undefined);
    return ok ? 'granted' : 'denied';
  } catch {
    // A few phones hide that dialog: open the full battery-optimisation list instead.
    try {
      await IL.startActivityAsync('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
    } catch {
      openAppSettings();
    }
    return 'denied';
  }
}

/** For the Permissions screen. */
export function batteryPermission(why: string, ifDenied: string): PermissionItem {
  return {
    key: 'battery',
    title: 'Battery: don’t optimise',
    why,
    ifDenied,
    required: false,
    check: batteryState,
    request: requestBatteryExemption,
  };
}

/** For the Home card: whether to show it, and the actions. */
export function useBatteryNudge() {
  const [state, setState] = useState<PermState | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const refresh = useCallback(async () => {
    setState(await batteryState());
    setDismissed(!!(await vault.get<boolean>(DISMISS_KEY, (v) => v === true).catch(() => null)));
  }, []);
  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void refresh());
    return () => sub.remove();
  }, [refresh]);
  return {
    show: Platform.OS === 'android' && state === 'denied' && !dismissed,
    async fix() {
      setState(await requestBatteryExemption());
    },
    async dismiss() {
      setDismissed(true);
      await vault.set(DISMISS_KEY, true).catch(() => undefined);
    },
    oem: AGGRESSIVE_OEM.test(brand()) ? brand() : null,
  };
}
