/**
 * How the developer appears to an institution's people in notifications when acting on their
 * accounts: by name, or as "Attendly support". Either way every action is recorded in the audit log
 * under the developer's own account. Remembered on this phone.
 */
import { useSyncExternalStore } from 'react';
import type { SupportAttribution } from '@attendly/protocol';
import { vault } from '@kit/lib/vault';

const KEY = 'support.attribution.v1';
let current: SupportAttribution = 'named';
const listeners = new Set<() => void>();
void vault
  .get<SupportAttribution>(KEY, (v) => (v === 'support' || v === 'named' ? v : null) as SupportAttribution)
  .then((v) => {
    if (v) {
      current = v;
      listeners.forEach((l) => l());
    }
  })
  .catch(() => undefined);

export function setAttribution(v: SupportAttribution) {
  current = v;
  listeners.forEach((l) => l());
  void vault.set(KEY, v).catch(() => undefined);
}

export function useAttribution(): SupportAttribution {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
