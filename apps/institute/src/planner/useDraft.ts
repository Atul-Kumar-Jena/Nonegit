import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DraftOp, PublishResponse } from '@attendly/protocol';
import { ApiRequestError } from '@kit/lib/api-core';
import { vault } from '@kit/lib/vault';
import { useApi } from '@kit/state/session';
import { staffApi } from '@/api';
import { useDrafts } from '@/queries';

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'error';
const BACKUP_KEY = 'planner.backup.v1';
interface Backup {
  draftId: string | null;
  version: number;
  title: string;
  ops: DraftOp[];
  at: number;
}

/**
 * The admin's working draft: loaded from the server (continue where anyone left
 * off), autosaved after every change with optimistic version checks, backed up
 * encrypted on the phone when offline, and published in one call.
 */
export function useDraft(weekStart: string) {
  const api = useApi();
  const qc = useQueryClient();
  const drafts = useDrafts();
  const [draftId, setDraftId] = useState<string | null>(null);
  const [title, setTitle] = useState('Timetable changes');
  const [ops, setOpsState] = useState<DraftOp[]>([]);
  const [save, setSave] = useState<SaveState>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const version = useRef(0);
  const idRef = useRef<string | null>(null);
  const opsRef = useRef<DraftOp[]>([]);
  const dirty = useRef(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const adopt = useCallback((d: { id: string; version: number; ops: DraftOp[]; title: string }) => {
    idRef.current = d.id;
    version.current = d.version;
    opsRef.current = d.ops;
    setDraftId(d.id);
    setTitle(d.title);
    setOpsState(d.ops);
  }, []);

  // Start: an unsaved local backup wins, else the newest open draft on the server, else a blank one.
  useEffect(() => {
    if (ready || drafts.isPending) return;
    void (async () => {
      const backup = await vault.get<Backup>(BACKUP_KEY, (v) => v as Backup).catch(() => null);
      const open = (drafts.data ?? []).find((d) => d.status === 'draft');
      try {
        if (backup && backup.ops.length && (!open || backup.draftId === open.id || !backup.draftId)) {
          idRef.current = backup.draftId;
          version.current = backup.version;
          opsRef.current = backup.ops;
          setDraftId(backup.draftId);
          setTitle(backup.title);
          setOpsState(backup.ops);
          dirty.current = true;
          setNotice('Restored changes saved on this phone while offline. They’ll sync now.');
        } else if (open) adopt(await staffApi.draft(api, open.id));
      } catch {
        // offline at start: begin blank; nothing is lost (the server copy stays)
      }
      setReady(true);
    })();
  }, [ready, drafts.isPending, drafts.data, api, adopt]);

  const persist = useCallback(() => {
    chain.current = chain.current.then(async () => {
      if (!dirty.current) return;
      dirty.current = false;
      const snapshot = opsRef.current;
      setSave('saving');
      try {
        if (!idRef.current) {
          const d = await staffApi.createDraft(api, title, weekStart);
          idRef.current = d.id;
          version.current = d.version;
          setDraftId(d.id);
        }
        const saved = await staffApi.saveDraft(api, idRef.current!, version.current, snapshot, title);
        version.current = saved.version;
        setSave(dirty.current ? 'saving' : 'saved');
        await vault.remove(BACKUP_KEY);
        void qc.invalidateQueries({ queryKey: ['staff', 'drafts'] });
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'CONFLICT' && idRef.current) {
          // Someone else changed (or published) this draft: take theirs, tell the admin.
          try {
            const fresh = await staffApi.draft(api, idRef.current);
            if (fresh.status === 'draft') {
              adopt(fresh);
              setNotice(`${fresh.updatedBy ?? 'Another admin'} changed this draft at the same time. Their version is loaded — redo your last change if it’s missing.`);
            } else {
              reset();
              setNotice(`This draft was ${fresh.status} by ${fresh.updatedBy ?? 'another admin'}. You’re on a fresh draft now.`);
            }
          } catch {
            setSave('error');
          }
          setSave('idle');
          return;
        }
        dirty.current = true;
        const offline = err instanceof ApiRequestError && err.transient;
        setSave(offline ? 'offline' : 'error');
        if (!offline) setNotice(err instanceof Error ? err.message : 'Couldn’t save the draft.');
        await vault.set(BACKUP_KEY, { draftId: idRef.current, version: version.current, title, ops: snapshot, at: Date.now() } satisfies Backup).catch(() => undefined);
      }
    });
    return chain.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, title, weekStart, qc, adopt]);

  const setOps = useCallback(
    (next: DraftOp[]) => {
      opsRef.current = next;
      setOpsState(next);
      dirty.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void persist(), 700);
    },
    [persist],
  );

  // Offline? keep retrying quietly.
  useEffect(() => {
    if (save !== 'offline') return;
    const t = setInterval(() => {
      dirty.current = true;
      void persist();
    }, 15_000);
    return () => clearInterval(t);
  }, [save, persist]);

  function reset() {
    idRef.current = null;
    version.current = 0;
    opsRef.current = [];
    dirty.current = false;
    setDraftId(null);
    setTitle('Timetable changes');
    setOpsState([]);
    setSave('idle');
    void vault.remove(BACKUP_KEY);
  }

  const publish = useCallback(
    async (acceptWarnings: boolean): Promise<PublishResponse> => {
      if (timer.current) clearTimeout(timer.current);
      dirty.current = dirty.current || !idRef.current;
      await persist();
      if (!idRef.current || dirty.current) throw new Error('The draft couldn’t be saved. Check your connection and try again.');
      const r = await staffApi.publishDraft(api, idRef.current, version.current, acceptWarnings);
      if (r.published) {
        reset();
        void qc.invalidateQueries({ queryKey: ['staff'] });
      }
      return r;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, persist, qc],
  );

  const discard = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    await chain.current;
    if (idRef.current) await staffApi.discardDraft(api, idRef.current).catch(() => undefined);
    reset();
    void qc.invalidateQueries({ queryKey: ['staff', 'drafts'] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, qc]);

  const openDraft = useCallback(
    async (id: string) => {
      if (timer.current) clearTimeout(timer.current);
      await persist();
      adopt(await staffApi.draft(api, id));
    },
    [api, persist, adopt],
  );

  const rename = useCallback(
    (t: string) => {
      setTitle(t);
      dirty.current = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void persist(), 700);
    },
    [persist],
  );

  return { ready, draftId, title, ops, setOps, save, notice, clearNotice: () => setNotice(null), publish, discard, openDraft, rename, drafts: drafts.data ?? [] };
}
