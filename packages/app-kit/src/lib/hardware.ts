/**
 * The phone's security chip as the API client's HardwareSigner (Android: TEE / StrongBox via
 * @attendly/hardware-key). Elsewhere — the web preview, iOS — there is none and the server decides
 * whether a software-only key is still allowed.
 */
import { Platform } from 'react-native';
import { hardwareKey } from '@attendly/hardware-key';
import { toB64url } from '@attendly/protocol';
import type { HardwareSigner } from './api-core';

const ALIAS = 'attendly.device.v1';

/** Standard (padded) base64, which Android's Base64 decoder expects. */
function b64(bytes: Uint8Array): string {
  const s = toB64url(bytes).replace(/-/g, '+').replace(/_/g, '/');
  return s + '='.repeat((4 - (s.length % 4)) % 4);
}
const utf8 = (s: string) => new TextEncoder().encode(s);

export const hardwareSigner: HardwareSigner | undefined =
  Platform.OS === 'android' && hardwareKey.available
    ? {
        async attest(challenge) {
          const r = await hardwareKey.generate(ALIAS, b64(challenge));
          return r.chain.length >= 2 ? r.chain : null;
        },
        async sign(data) {
          if (!hardwareKey.hasKey(ALIAS)) return null;
          return hardwareKey.sign(ALIAS, b64(utf8(data)));
        },
      }
    : undefined;

/** Forget the chip key (with the rest of this phone's identity). */
export function removeHardwareKey() {
  try {
    hardwareKey.remove(ALIAS);
  } catch {
    // nothing to remove
  }
}
