/**
 * Instant phone notifications through Firebase Cloud Messaging (HTTP v1).
 *
 * Every notification row is sent by a small dispatcher *after* its transaction commits
 * (it reads committed rows only), so a rolled-back change never buzzes anyone. Without
 * FCM_SERVICE_ACCOUNT the dispatcher does nothing and the apps' own checks deliver instead.
 */
import { notificationCategory } from '@attendly/protocol';
import { createSign } from 'node:crypto';
import { switchOn } from './flags';
import type { Db } from '../db';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export function parseServiceAccount(raw: string | undefined): ServiceAccount | null {
  if (!raw?.trim()) return null;
  try {
    const j = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) as ServiceAccount;
    return j.project_id && j.client_email && j.private_key ? { ...j, private_key: j.private_key.replace(/\\n/g, '\n') } : null;
  } catch {
    return null;
  }
}

/** Delivery counters since the server started (shown in the Developer console to find push problems). */
export const pushStats = { sent: 0, failed: 0, deadTokens: 0, lastError: null as string | null, lastErrorAt: null as string | null, lastSentAt: null as string | null };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function createPushSender(sa: ServiceAccount, log: (msg: string, extra?: unknown) => void) {
  let token: { value: string; exp: number } | null = null;
  async function accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (token && token.exp - 60 > now) return token.value;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
    const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      pushStats.failed++;
      pushStats.lastError = `Google sign-in for FCM failed (${res.status}) — check FCM_SERVICE_ACCOUNT: ${detail.slice(0, 200)}`;
      pushStats.lastErrorAt = new Date().toISOString();
      throw new Error(`FCM auth failed: ${res.status}`);
    }
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, exp: now + j.expires_in };
    return token.value;
  }
  /** 'ok' = Google accepted it for the phone; 'dead' = the token is gone (app uninstalled): forget it; 'failed' = try later / app checks itself. */
  async function send(to: string, n: { title: string; body: string; data: Record<string, string>; image?: string; tag?: string }): Promise<'ok' | 'dead' | 'failed'> {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: to,
          notification: { title: n.title, body: n.body },
          data: n.data,
          android: {
            priority: 'HIGH',
            notification: {
              channel_id: 'timetable-alerts',
              sound: 'default',
              default_vibrate_timings: true,
              notification_priority: 'PRIORITY_MAX',
              visibility: 'PUBLIC',
              icon: 'notification_icon',
              color: '#111111',
              // A thumbnail for each kind of news; a newer update about the same thing replaces the older one.
              ...(n.image ? { image: n.image } : {}),
              ...(n.tag ? { tag: n.tag } : {}),
            },
          },
          apns: { payload: { aps: { sound: 'default' } } },
        },
      }),
    });
    if (res.status === 404 || res.status === 400) {
      pushStats.deadTokens++;
      return 'dead';
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      pushStats.failed++;
      pushStats.lastError = `FCM ${res.status}: ${detail.slice(0, 300)}`;
      pushStats.lastErrorAt = new Date().toISOString();
      log('FCM send failed', { status: res.status, detail: detail.slice(0, 300) });
      return 'failed';
    }
    pushStats.sent++;
    pushStats.lastSentAt = new Date().toISOString();
    return 'ok';
  }
  return { send };
}

/** Sends every committed, not-yet-pushed notification of the last 10 minutes. */
export function startPushDispatcher(
  db: Db,
  sender: ReturnType<typeof createPushSender>,
  log: (msg: string, extra?: unknown) => void,
  publicUrl: string | null = null,
): () => void {
  let running = false;
  const BATCH = 500;
  const PARALLEL = 25;
  /** One batch: claim up to BATCH unsent notifications, push them with PARALLEL requests at a time. */
  const round = async (): Promise<number> => {
    // Platform switch: phone notifications paused (the in-app bell still fills; nothing is pushed).
    if (await switchOn(db, 'notifications_paused').catch(() => false)) return 0;
    const { rows } = await db.query<{ id: string; user_id: string; kind: string; title: string; body: string; data: Record<string, unknown> }>(
      `update notifications set pushed_at = now()
        where id in (select id from notifications where pushed_at is null and created_at > now() - interval '10 minutes' order by id limit ${BATCH} for update skip locked)
        returning id, user_id, kind, title, body, data`,
    );
    if (!rows.length) return 0;
    const tokens = await db.query<{ user_id: string; token: string; device_id: string }>(
      `select p.user_id, p.token, p.device_id from push_tokens p join devices d on d.id = p.device_id and d.status = 'active' where p.user_id = any($1::uuid[])`,
      [[...new Set(rows.map((r) => r.user_id))]],
    );
    const byUser = new Map<string, { token: string; device_id: string }[]>();
    for (const t of tokens.rows) byUser.set(t.user_id, [...(byUser.get(t.user_id) ?? []), t]);
    const jobs: (() => Promise<void>)[] = [];
    /** Notifications Google accepted for at least one of the person's phones: the app won't repeat them. */
    const delivered = new Set<string>();
    for (const n of rows) {
      const first = (n.data.changes as { sessionId?: string | null; courseId?: string }[] | undefined)?.[0];
      const data: Record<string, string> = {
        notificationId: String(n.id),
        kind: n.kind,
        ...(first?.sessionId ? { sessionId: first.sessionId } : typeof n.data.sessionId === 'string' ? { sessionId: n.data.sessionId } : {}),
        ...(first?.courseId ? { courseId: first.courseId } : typeof n.data.courseId === 'string' ? { courseId: n.data.courseId } : {}),
        ...(typeof n.data.batchId === 'string' ? { batchId: n.data.batchId } : {}),
        ...(typeof n.data.requestId === 'string' ? { requestId: n.data.requestId } : {}),
        ...(typeof n.data.noticeId === 'string' ? { noticeId: n.data.noticeId } : {}),
      };
      const image = publicUrl ? `${publicUrl}/v1/thumbs/${notificationCategory(n.kind)}.png` : undefined;
      const about = data.noticeId ?? data.requestId ?? data.sessionId;
      const tag = about ? `${n.kind}:${about}` : undefined;
      for (const t of byUser.get(n.user_id) ?? [])
        jobs.push(async () => {
          const r = await sender.send(t.token, { title: n.title, body: n.body, data, image, tag }).catch((err: Error) => (log('FCM error', { err: err.message }), 'failed' as const));
          if (r === 'dead') await db.query('delete from push_tokens where device_id = $1', [t.device_id]);
          if (r === 'ok') delivered.add(n.id);
        });
    }
    for (let i = 0; i < jobs.length; i += PARALLEL) await Promise.all(jobs.slice(i, i + PARALLEL).map((j) => j()));
    if (delivered.size) await db.query('update notifications set push_ok = true where id = any($1::bigint[])', [[...delivered]]);
    return rows.length;
  };
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Keep going until the queue is empty, so a broadcast to thousands goes out in seconds.
      for (let i = 0; i < 40 && (await round()) === BATCH; i++);
    } catch (err) {
      log('push dispatcher error', { err: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), 2000);
  return () => clearInterval(t);
}
