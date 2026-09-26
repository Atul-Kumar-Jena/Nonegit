import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Secret storage backed by the iOS Keychain / Android Keystore-encrypted
 * SecureStore, restricted to this device (never synced to iCloud / Google
 * backups — restoring onto another phone must not clone the device identity).
 *
 * The web build exists only for UI previews; it keeps secrets in memory for
 * the lifetime of the tab and the server refuses web devices by default.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const memory = new Map<string, string>();
const isWeb = Platform.OS === 'web';

export const StorageKeys = {
  deviceKey: 'attendly.device-key.v1',
  tokens: 'attendly.tokens.v1',
  server: 'attendly.server.v1',
  prefs: 'attendly.prefs.v1',
} as const;

export async function getItem(key: string): Promise<string | null> {
  if (isWeb) return memory.get(key) ?? null;
  return SecureStore.getItemAsync(key, OPTIONS);
}

export async function setItem(key: string, value: string): Promise<void> {
  if (isWeb) {
    memory.set(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value, OPTIONS);
}

export async function deleteItem(key: string): Promise<void> {
  if (isWeb) {
    memory.delete(key);
    return;
  }
  await SecureStore.deleteItemAsync(key, OPTIONS);
}

export async function getJson<T>(key: string, validate: (v: unknown) => T | null): Promise<T | null> {
  const raw = await getItem(key);
  if (!raw) return null;
  try {
    return validate(JSON.parse(raw));
  } catch {
    // Corrupt entry: drop it rather than crash on every launch.
    await deleteItem(key).catch(() => undefined);
    return null;
  }
}

export async function setJson(key: string, value: unknown): Promise<void> {
  await setItem(key, JSON.stringify(value));
}
