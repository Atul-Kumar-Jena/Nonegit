/**
 * Offline outbox: actions taken without internet (a student's scan, a teacher's
 * register, a class started offline) are stored encrypted on the phone and
 * uploaded automatically when the connection returns.
 *
 *  • Survives app restarts (vault-backed).
 *  • Every item carries its own idempotency key, so retries never double-apply.
 *  • Network/server hiccups → retried with backoff. Session problems → paused
 *    until the person signs in again. A definitive refusal → reported, never
 *    retried silently.
 */
import { useSyncExternalStore } from 'react';
import { randomToken } from '@attendly/protocol';
import { ApiRequestError, type ApiClient } from './api-core';
import { vault } from './vault';

export interface OutboxItem {
  id: string;
  kind: string;
  /** Human-readable, e.g. "CS-301 scan · 10:14". */
  label: string;
  payload: unknown;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  state: 'pending' | 'failed';
}

export interface OutboxResult {
  id: string;
  kind: string;
  label: string;
  ok: boolean;
  message: string;
  at: number;
}

export type OutboxOutcome = { ok: boolean; message: string };
export type OutboxHandler = (api: ApiClient, item: OutboxItem) => Promise<OutboxOutcome>;

const ITEMS_KEY = 'outbox.items.v1';
const RESULTS_KEY = 'outbox.results.v1';
const MAX_RESULTS = 30;
const SESSION_CODES = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'DEVICE_REVOKED', 'ACCOUNT_SUSPENDED', 'BAD_SIGNATURE', 'CLOCK_SKEW']);

interface State {
  items: OutboxItem[];
  results: OutboxResult[];
  syncing: boolean;
  loaded: boolean;
}

let state: State = { items: [], results: [], syncing: false, loaded: false };
const listeners = new Set<() => void>();
let chain: Promise<unknown> = Promise.resolve();

function emit(next: Partial<State>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Serialises every read-modify-write so concurrent calls can't lose items. */
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function load() {
  if (state.loaded) return;
  const [items, results] = await Promise.all([
    vault.get<OutboxItem[]>(ITEMS_KEY, (v) => (Array.isArray(v) ? (v as OutboxItem[]) : [])),
    vault.get<OutboxResult[]>(RESULTS_KEY, (v) => (Array.isArray(v) ? (v as OutboxResult[]) : [])),
  ]);
  emit({ items: items ?? [], results: results ?? [], loaded: true });
}

async function save(items: OutboxItem[], results = state.results) {
  await vault.set(ITEMS_KEY, items);
  if (results !== state.results) await vault.set(RESULTS_KEY, results);
  emit({ items, results });
}

function backoff(attempts: number): number {
  return Math.min(5_000 * 2 ** attempts, 5 * 60_000);
}

export const outbox = {
  /** Queue an action. Returns its id (usable as an idempotency key). */
  enqueue(kind: string, label: string, payload: unknown, id = randomToken(16)): Promise<string> {
    return locked(async () => {
      await load();
      const item: OutboxItem = { id, kind, label, payload, createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, lastError: null, state: 'pending' };
      await save([...state.items, item]);
      return id;
    });
  },

  /** Try to upload everything that is due. Safe to call often; runs one pass at a time. */
  flush(api: ApiClient | null, handlers: Record<string, OutboxHandler>, opts: { force?: boolean } = {}): Promise<void> {
    if (!api || state.syncing) return Promise.resolve();
    return locked(async () => {
      await load();
      const due = state.items.filter((i) => i.state === 'pending' && (opts.force || i.nextAttemptAt <= Date.now()));
      if (!due.length) return;
      emit({ syncing: true });
      try {
        for (const item of due) {
          const handler = handlers[item.kind];
          if (!handler) continue;
          try {
            const outcome = await handler(api, item);
            const result: OutboxResult = { id: item.id, kind: item.kind, label: item.label, ok: outcome.ok, message: outcome.message, at: Date.now() };
            await save(
              state.items.filter((i) => i.id !== item.id),
              [result, ...state.results].slice(0, MAX_RESULTS),
            );
          } catch (err) {
            const e = err instanceof ApiRequestError ? err : null;
            const message = err instanceof Error ? err.message : 'Upload failed';
            if (e && (e.transient || e.code === 'RATE_LIMITED')) {
              await save(state.items.map((i) => (i.id === item.id ? { ...i, attempts: i.attempts + 1, nextAttemptAt: Date.now() + backoff(i.attempts), lastError: message } : i)));
              if (e.code === 'NETWORK' || e.code === 'TIMEOUT') break; // offline: stop this pass
              continue;
            }
            if (e && SESSION_CODES.has(e.code)) {
              // Keep everything; it uploads after the next sign-in.
              await save(state.items.map((i) => (i.id === item.id ? { ...i, lastError: 'Waiting for you to sign in again' } : i)));
              break;
            }
            // A definitive refusal (validation, permissions, conflict): stop retrying and tell the person.
            await save(state.items.map((i) => (i.id === item.id ? { ...i, state: 'failed', lastError: message, attempts: i.attempts + 1 } : i)));
          }
        }
      } finally {
        emit({ syncing: false });
      }
    });
  },

  retry(id: string): Promise<void> {
    return locked(async () => {
      await load();
      await save(state.items.map((i) => (i.id === id ? { ...i, state: 'pending', nextAttemptAt: 0 } : i)));
    });
  },

  discard(id: string): Promise<void> {
    return locked(async () => {
      await load();
      await save(state.items.filter((i) => i.id !== id));
    });
  },

  clearResults(): Promise<void> {
    return locked(async () => {
      await load();
      await vault.set(RESULTS_KEY, []);
      emit({ results: [] });
    });
  },

  /** Removes everything (sign-out / erase). */
  wipe(): Promise<void> {
    return locked(async () => {
      await vault.remove(ITEMS_KEY);
      await vault.remove(RESULTS_KEY);
      emit({ items: [], results: [], loaded: true });
    });
  },

  snapshot(): State {
    return state;
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    void load();
    return () => listeners.delete(fn);
  },
};

export function useOutbox() {
  const s = useSyncExternalStore(outbox.subscribe, outbox.snapshot, outbox.snapshot);
  return {
    items: s.items,
    pending: s.items.filter((i) => i.state === 'pending'),
    failed: s.items.filter((i) => i.state === 'failed'),
    results: s.results,
    syncing: s.syncing,
  };
}
