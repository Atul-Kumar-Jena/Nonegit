/**
 * Android hardware-backed signing key with Google key attestation (see the Kotlin module).
 * Everywhere else (iOS for now, the web preview, older builds) `available` is false and
 * the app falls back to its software key; the server decides whether that is allowed.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

interface Native {
  isSupported(): boolean;
  hasKey(alias: string): boolean;
  remove(alias: string): boolean;
  generate(alias: string, challengeB64: string): Promise<{ chain: string[]; strongBox: boolean }>;
  sign(alias: string, dataB64: string): Promise<string>;
}

const native = requireOptionalNativeModule<Native>('AttendlyHardwareKey');

function supported(): boolean {
  try {
    return !!native && native.isSupported();
  } catch {
    return false;
  }
}

export const hardwareKey = {
  available: supported(),
  hasKey: (alias: string) => (native ? native.hasKey(alias) : false),
  remove: (alias: string) => void (native ? native.remove(alias) : false),
  generate: (alias: string, challengeB64: string) => {
    if (!native) throw new Error('Hardware key not available on this phone');
    return native.generate(alias, challengeB64);
  },
  sign: (alias: string, dataB64: string) => {
    if (!native) throw new Error('Hardware key not available on this phone');
    return native.sign(alias, dataB64);
  },
};
