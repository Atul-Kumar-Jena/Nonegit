import { getRandomValues } from 'expo-crypto';

/**
 * @noble/* reads `globalThis.crypto.getRandomValues` at call time and refuses
 * to work without it (it never falls back to Math.random). Hermes does not
 * ship WebCrypto, so we provide the OS CSPRNG via expo-crypto
 * (SecRandomCopyBytes on iOS, SecureRandom on Android).
 */
const g = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof g.crypto?.getRandomValues !== 'function') {
  const existing = g.crypto ?? {};
  Object.defineProperty(globalThis, 'crypto', {
    value: Object.assign(existing, { getRandomValues }),
    configurable: true,
    writable: true,
  });
}
