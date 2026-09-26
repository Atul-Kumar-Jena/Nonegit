import { useMemo } from 'react';
import type { RosterEntry, StaffSession } from '@attendly/protocol';
import { useLocalSessions, withLocal } from './local-sessions';
import { useOfflinePack, useOverview, useSession } from './queries';

/**
 * One class, from the best source available: the live server answer, else the
 * offline pack downloaded earlier, else today's overview — with anything this
 * phone did offline applied on top.
 */
export function useSessionView(id: string) {
  const q = useSession(id);
  const pack = useOfflinePack();
  const overview = useOverview();
  const local = useLocalSessions();

  return useMemo(() => {
    const packed = pack.data?.sessions.find((s) => s.id === id);
    const base: StaffSession | undefined = q.data?.session ?? packed ?? overview.data?.today.find((s) => s.id === id);
    const session = base ? withLocal(base, local) : undefined;
    const secret = q.data?.secret ?? local[id]?.secret ?? packed?.secret ?? null;
    const roster: RosterEntry[] | null = base ? (pack.data?.rosters[base.courseId] ?? null) : null;
    const tz = overview.data?.timezone ?? pack.data?.timezone;
    return { session, secret, roster, tz, query: q, fromCache: !q.data && !!base };
  }, [id, q, pack.data, overview.data, local]);
}
