/**
 * What this phone did to a class while offline (started it, ended it), kept
 * encrypted until the server confirms. Screens overlay it on the server's view,
 * so a teacher never sees a class "jump back" to scheduled after going offline.
 */
import { useSyncExternalStore } from 'react';
import type { SessionStatus, StaffSession } from '@attendly/protocol';
import { vault } from '@kit/lib/vault';

export interface LocalSession {
  sessionId: string;
  status: 'live' | 'closed';
  mode: 'qr' | 'manual';
  startedAt: number;
  endedAt: number | null;
  rotationS: number;
  /** QR secret (only for QR classes) so the code keeps rotating without internet. */
  secret: string | null;
  courseCode: string;
  courseTitle: string;
  savedAt: number;
}

const KEY = 'staff.local-sessions.v1';
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;
let state: Record<string, LocalSession> = {};
let loaded = false;
const listeners = new Set<() => void>();

function emit(next: Record<string, LocalSession>) {
  state = next;
  for (const l of listeners) l();
}

async function load() {
  if (loaded) return;
  loaded = true;
  const v = await vault.get<Record<string, LocalSession>>(KEY, (x) => (x && typeof x === 'object' ? (x as Record<string, LocalSession>) : {}));
  const now = Date.now();
  const fresh = Object.fromEntries(Object.entries(v ?? {}).filter(([, s]) => now - s.savedAt < MAX_AGE_MS));
  emit({ ...fresh, ...state });
}

async function persist(next: Record<string, LocalSession>) {
  emit(next);
  await vault.set(KEY, next).catch(() => undefined);
}

const RANK: Record<SessionStatus, number> = { scheduled: 0, live: 1, closed: 2, cancelled: 3 };

export const localSessions = {
  async put(s: Omit<LocalSession, 'savedAt'>) {
    await load();
    await persist({ ...state, [s.sessionId]: { ...s, savedAt: Date.now() } });
  },
  async patch(id: string, p: Partial<LocalSession>) {
    await load();
    const cur = state[id];
    if (cur) await persist({ ...state, [id]: { ...cur, ...p, savedAt: Date.now() } });
  },
  get(id: string): LocalSession | undefined {
    return state[id];
  },
  /** Drop local overrides the server has caught up with. */
  async settle(server: StaffSession[]) {
    await load();
    let changed = false;
    const next = { ...state };
    for (const s of server) {
      const l = next[s.id];
      if (l && RANK[s.status] >= RANK[l.status]) {
        delete next[s.id];
        changed = true;
      }
    }
    if (changed) await persist(next);
  },
  async wipe() {
    await persist({});
    await vault.remove(KEY);
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    void load();
    return () => listeners.delete(fn);
  },
  snapshot: () => state,
};

export function useLocalSessions() {
  return useSyncExternalStore(localSessions.subscribe, localSessions.snapshot, localSessions.snapshot);
}

/** The server's session with anything this phone did offline applied on top. */
export function withLocal(s: StaffSession, local: Record<string, LocalSession>): StaffSession & { pendingSync: boolean } {
  const l = local[s.id];
  if (!l || RANK[s.status] >= RANK[l.status]) return { ...s, pendingSync: false };
  return {
    ...s,
    status: l.status,
    mode: l.mode,
    startedAt: new Date(l.startedAt).toISOString(),
    endedAt: l.endedAt ? new Date(l.endedAt).toISOString() : s.endedAt,
    rotationS: l.rotationS,
    pendingSync: true,
  };
}
