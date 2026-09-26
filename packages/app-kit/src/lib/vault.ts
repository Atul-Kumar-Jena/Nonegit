/**
 * Encrypted on-device storage for everything bigger than a secret: cached
 * screens, offline packs and the outbox of actions waiting to upload.
 *
 *  • XChaCha20-Poly1305 (authenticated) with a random 256-bit key that lives
 *    only in the Keychain / Android Keystore-backed SecureStore.
 *  • The entry name is bound as associated data, so entries can't be swapped.
 *  • Anything that fails to decrypt (tampering, restored backup without the
 *    key) is discarded instead of crashing the app.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { fromB64url, randomBytes, toB64url, utf8Decode, utf8ToBytes } from '@attendly/protocol';
import { deleteItem, getItem, setItem } from './storage';

const KEY_NAME = 'attendly.vault-key.v1';
const PREFIX = 'attendly.vault.v1:';
const isWeb = Platform.OS === 'web';
const memory = new Map<string, string>();

let keyPromise: Promise<Uint8Array> | null = null;

async function vaultKey(): Promise<Uint8Array> {
  keyPromise ??= (async () => {
    const stored = await getItem(KEY_NAME);
    if (stored) {
      try {
        const k = fromB64url(stored);
        if (k.length === 32) return k;
      } catch {
        /* regenerate below */
      }
    }
    const k = randomBytes(32);
    await setItem(KEY_NAME, toB64url(k));
    return k;
  })().catch((err) => {
    keyPromise = null;
    throw err;
  });
  return keyPromise;
}

const rawGet = (k: string) => (isWeb ? Promise.resolve(memory.get(k) ?? null) : AsyncStorage.getItem(k));
const rawSet = (k: string, v: string) => (isWeb ? Promise.resolve(void memory.set(k, v)) : AsyncStorage.setItem(k, v));
const rawRemove = (k: string) => (isWeb ? Promise.resolve(void memory.delete(k)) : AsyncStorage.removeItem(k));

export const vault = {
  async get<T>(name: string, validate?: (v: unknown) => T): Promise<T | null> {
    const blob = await rawGet(PREFIX + name).catch(() => null);
    if (!blob) return null;
    try {
      const bytes = fromB64url(blob);
      const nonce = bytes.subarray(0, 24);
      const plain = xchacha20poly1305(await vaultKey(), nonce, utf8ToBytes(name)).decrypt(bytes.subarray(24));
      const value = JSON.parse(utf8Decode(plain)) as unknown;
      return validate ? validate(value) : (value as T);
    } catch {
      await rawRemove(PREFIX + name).catch(() => undefined);
      return null;
    }
  },

  async set(name: string, value: unknown): Promise<void> {
    const nonce = randomBytes(24);
    const sealed = xchacha20poly1305(await vaultKey(), nonce, utf8ToBytes(name)).encrypt(utf8ToBytes(JSON.stringify(value)));
    const out = new Uint8Array(24 + sealed.length);
    out.set(nonce, 0);
    out.set(sealed, 24);
    await rawSet(PREFIX + name, toB64url(out));
  },

  async remove(name: string): Promise<void> {
    await rawRemove(PREFIX + name).catch(() => undefined);
  },

  /** Wipes every vault entry and the key (sign-out of a device identity / erase). */
  async destroy(): Promise<void> {
    if (isWeb) {
      for (const k of [...memory.keys()]) if (k.startsWith(PREFIX)) memory.delete(k);
    } else {
      const keys = (await AsyncStorage.getAllKeys().catch(() => [] as readonly string[])).filter((k) => k.startsWith(PREFIX));
      if (keys.length) await AsyncStorage.multiRemove(keys).catch(() => undefined);
    }
    keyPromise = null;
    await deleteItem(KEY_NAME).catch(() => undefined);
  },
};

/** A string-keyed storage adapter (for the React Query persister) backed by the vault. */
export const vaultStorage = {
  getItem: async (key: string) => {
    const v = await vault.get<string>(key, (x) => (typeof x === 'string' ? x : null) as string);
    return v;
  },
  setItem: (key: string, value: string) => vault.set(key, value),
  removeItem: (key: string) => vault.remove(key),
};
