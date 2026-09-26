import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import type { DeviceInfo } from '@attendly/protocol';
import { APP_VERSION } from './env';

export interface IntegrityReport {
  rooted: boolean;
  emulator: boolean;
}

/**
 * Best-effort local integrity signals. They are reported to the server, which
 * refuses rooted/jailbroken phones and emulators. (Hardware attestation via
 * Play Integrity / App Attest plugs in here when the institution enables it.)
 */
export async function integrityReport(): Promise<IntegrityReport> {
  let rooted = false;
  try {
    rooted = Platform.OS === 'web' ? false : await Device.isRootedExperimentalAsync();
  } catch {
    rooted = false;
  }
  return { rooted, emulator: Platform.OS !== 'web' && !Device.isDevice };
}

function clip(s: string | null | undefined, max: number, fallback: string): string {
  const v = (s ?? '').trim();
  return (v || fallback).slice(0, max);
}

export async function collectDeviceInfo(): Promise<Omit<DeviceInfo, 'publicKey'>> {
  const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
  const model = Platform.OS === 'web' ? 'Web browser' : clip(Device.modelName ?? [Device.manufacturer, Device.modelId].filter(Boolean).join(' '), 80, 'Unknown device');
  const osVersion = clip(Platform.OS === 'web' ? 'web' : `${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`, 40, Platform.OS);
  return { platform, model, osVersion, appVersion: clip(APP_VERSION, 20, '1.0.0'), integrity: await integrityReport(), ...(await hardwareId()) };
}

/** Stable per physical phone: Android ID (kept across clearing data / reinstalling) or the iOS vendor ID. */
async function hardwareId(): Promise<{ hardwareId?: string }> {
  try {
    const id = Platform.OS === 'android' ? Application.getAndroidId() : Platform.OS === 'ios' ? await Application.getIosIdForVendorAsync() : null;
    return id && id.length >= 4 ? { hardwareId: id.slice(0, 128) } : {};
  } catch {
    return {};
  }
}
