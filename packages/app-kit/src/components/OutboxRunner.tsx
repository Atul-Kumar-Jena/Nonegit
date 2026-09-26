import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { outbox, type OutboxHandler } from '../lib/outbox';
import { useSession } from '../state/session';

const INTERVAL_MS = 20_000;
let registered: Record<string, OutboxHandler> = {};

/** Upload now (e.g. a "Send now" button). */
export function flushOutboxNow(api: import('../lib/api-core').ApiClient | null) {
  return outbox.flush(api, registered, { force: true });
}

/**
 * Keeps the offline outbox moving: tries on start, whenever the app comes to
 * the foreground, every 20 s while anything is waiting, and right after sign-in.
 */
export function OutboxRunner({ handlers }: { handlers: Record<string, OutboxHandler> }) {
  const { api, phase } = useSession();
  const qc = useQueryClient();
  const ref = useRef(handlers);
  ref.current = handlers;
  registered = handlers;

  useEffect(() => {
    if (phase !== 'signed-in' || !api) return;
    const run = () => void outbox.flush(api, ref.current).catch(() => undefined);
    run();
    const timer = setInterval(() => {
      if (outbox.snapshot().items.some((i) => i.state === 'pending')) run();
    }, INTERVAL_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') run();
    });
    // Something uploaded → refresh every screen so it shows the server's view.
    let lastResult = outbox.snapshot().results[0]?.id;
    const unsub = outbox.subscribe(() => {
      const head = outbox.snapshot().results[0]?.id;
      if (head && head !== lastResult) void qc.invalidateQueries();
      lastResult = head;
    });
    return () => {
      clearInterval(timer);
      sub.remove();
      unsub();
    };
  }, [api, phase, qc]);

  return null;
}
