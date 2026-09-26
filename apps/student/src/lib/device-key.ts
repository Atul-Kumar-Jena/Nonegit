import { ED25519_SECRET_KEY_BYTES, fromB64url, generateKeyPair, keyFingerprint, publicKeyFromSecret, toB64url } from '@attendly/protocol';
import type { DeviceKeyProvider } from './api-core';
import { StorageKeys, deleteItem, getItem, setItem } from './storage';

/**
 * The device identity: an Ed25519 key generated on this phone from the OS
 * CSPRNG. The secret never leaves secure storage except to sign in memory;
 * only the public key is ever sent to the server.
 */
let cached: { secretKey: Uint8Array; publicKey: Uint8Array } | null = null;
let loading: Promise<{ secretKey: Uint8Array; publicKey: Uint8Array }> | null = null;

async function load() {
  if (cached) return cached;
  if (loading) return loading;
  loading = (async () => {
    try {
      const stored = await getItem(StorageKeys.deviceKey);
      if (stored) {
        try {
          const secretKey = fromB64url(stored);
          if (secretKey.length === ED25519_SECRET_KEY_BYTES) {
            cached = { secretKey, publicKey: publicKeyFromSecret(secretKey) };
            return cached;
          }
        } catch {
          // fall through and regenerate — an unreadable key cannot be used anyway
        }
      }
      const kp = generateKeyPair();
      await setItem(StorageKeys.deviceKey, toB64url(kp.secretKey));
      // Read back to be certain the key really persisted before we bind to it.
      const check = await getItem(StorageKeys.deviceKey);
      if (check !== toB64url(kp.secretKey)) throw new Error('Secure storage is unavailable on this device.');
      cached = kp;
      return cached;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export const deviceKeys: DeviceKeyProvider = {
  secretKey: async () => (await load()).secretKey,
  publicKey: async () => (await load()).publicKey,
};

export async function deviceFingerprint(): Promise<string> {
  return keyFingerprint(await deviceKeys.publicKey());
}

/** Permanently destroys this phone's identity. Re-binding then needs admin approval. */
export async function destroyDeviceKey(): Promise<void> {
  cached = null;
  await deleteItem(StorageKeys.deviceKey);
}
