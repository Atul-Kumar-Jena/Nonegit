/**
 * Broadcasts from Attendly (Developer app): one message to everyone, only students, only admins or
 * all faculty — in every active, verified institution or in one. Each institution gets an ordinary
 * notice (read-only for it) plus a phone notification; the copies share a broadcast id so the
 * developer sees how many received and saw it. Signed "Attendly" or with the developer's name, and
 * always recorded under the developer's account.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BroadcastBody, BroadcastTarget, NOTICE_CATEGORIES, richToPlain, type BroadcastPreview, type BroadcastSummary } from '@attendly/protocol';
import type { Deps } from '../deps';
import { withTx, type Queryable } from '../db';
import { appendAudit } from '../lib/audit';
import { ApiError } from '../lib/errors';
import { insertNotifications } from '../lib/notify';
import { noSandbox, requireRoot, type RootAuth } from './root';
import { audienceLabel } from './notices';

const ROLES: Record<'everyone' | 'students' | 'admins' | 'staff', string[]> = {
  everyone: ['student', 'teacher', 'admin'],
  students: ['student'],
  admins: ['admin'],
  staff: ['teacher', 'admin'],
};

async function targets(db: Queryable, r: RootAuth, tenantId: string | null) {
  const { rows } = await db.query<{ id: string; name: string }>(
    `select id, name from tenants
      where status = 'active' and verified_at is not null and slug <> 'attendly-platform'
        and ($1::uuid is null or id = $1) and ($2::uuid[] is null or id = any($2))`,
    [tenantId, r.tenants],
  );
  if (tenantId && !rows.length) throw new ApiError(404, 'NOT_FOUND', 'Institution not found (or not active and verified).');
  return rows;
}

async function recipients(db: Queryable, tenantId: string, roles: string[]) {
  const { rows } = await db.query<{ id: string }>(`select id from users where tenant_id = $1 and status = 'active' and role = any($2::text[])`, [tenantId, roles]);
  return rows.map((x) => x.id);
}

export async function rootBroadcastRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/v1/root/broadcast/preview', async (req): Promise<BroadcastPreview> => {
    const r = await requireRoot(req, deps);
    const t = BroadcastTarget.parse(req.body);
    const list = await targets(deps.db, r, t.tenantId);
    const { rows } = await deps.db.query<{ n: number }>(
      `select count(*)::int as n from users where status = 'active' and role = any($1::text[]) and tenant_id = any($2::uuid[])`,
      [ROLES[t.audience], list.map((x) => x.id)],
    );
    return { institutions: list.length, recipients: rows[0]!.n, label: `${audienceLabel(t.audience)} · ${t.tenantId ? list[0]!.name : `${list.length} institutions`}` };
  });

  app.post('/v1/root/broadcast', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<BroadcastSummary> => {
    const r = await requireRoot(req, deps);
    noSandbox(r, 'broadcasting');
    const b = BroadcastBody.parse(req.body);
    const broadcastId = randomUUID();
    const signedAs = b.as === 'named' ? r.name : 'Attendly';
    const emoji = NOTICE_CATEGORIES.find((c) => c.key === b.category)?.emoji ?? '📢';
    const preview = richToPlain(b.body, 160);
    const label = audienceLabel(b.audience);
    const sent = await withTx(deps.db, async (tx) => {
      const list = await targets(tx, r, b.tenantId);
      if (!list.length) throw new ApiError(409, 'CONFLICT', 'No active, verified institution to send to.');
      let total = 0;
      for (const t of list) {
        const to = await recipients(tx, t.id, ROLES[b.audience]);
        const { rows } = await tx.query<{ id: string }>(
          `insert into notices(tenant_id, author_id, title, body, category, audience, audience_label, pinned, important, recipients, platform, author_label, broadcast_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $12) returning id`,
          [t.id, r.userId, b.title, b.body, b.category, b.audience, label, b.pinned, b.important, to.length, signedAs, broadcastId],
        );
        const noticeId = rows[0]!.id;
        await insertNotifications(
          tx,
          t.id,
          to.map((userId) => ({ userId, kind: 'notice', title: `${b.important ? '⚠️ Important · ' : `${emoji} `}${b.title}`, body: `${signedAs}: ${preview}`, data: { noticeId } })),
        );
        await appendAudit(tx, { tenantId: t.id, actorType: 'user', actorId: r.userId, action: 'notice.platform_send', subject: `notice:${noticeId}`, data: { audience: label, recipients: to.length, signedAs, broadcastId } });
        total += to.length;
      }
      await appendAudit(tx, { tenantId: null, actorType: 'user', actorId: r.userId, action: 'root.broadcast', subject: `broadcast:${broadcastId}`, data: { audience: label, institutions: list.length, recipients: total, signedAs, title: b.title } });
      return { institutions: list.length, recipients: total };
    });
    return { id: broadcastId, title: b.title, audienceLabel: label, signedAs, institutions: sent.institutions, recipients: sent.recipients, seen: 0, important: b.important, createdAt: new Date(deps.clock()).toISOString() };
  });

  app.get('/v1/root/broadcasts', async (req): Promise<BroadcastSummary[]> => {
    const r = await requireRoot(req, deps);
    const { rows } = await deps.db.query<{ id: string; title: string; audience_label: string; author_label: string | null; institutions: number; recipients: number; seen: number; important: boolean; created_at: Date }>(
      `select n.broadcast_id as id, min(n.title) as title, min(n.audience_label) as audience_label, min(n.author_label) as author_label,
              count(*)::int as institutions, sum(n.recipients)::int as recipients, bool_or(n.important) as important, min(n.created_at) as created_at,
              (select count(*)::int from notice_reads x join notices m on m.id = x.notice_id where m.broadcast_id = n.broadcast_id) as seen
         from notices n
        where n.platform and n.broadcast_id is not null and n.deleted_at is null and ($1::uuid[] is null or n.tenant_id = any($1))
        group by n.broadcast_id
        order by min(n.created_at) desc limit 50`,
      [r.tenants],
    );
    return rows.map((x) => ({
      id: x.id,
      title: x.title,
      audienceLabel: x.audience_label,
      signedAs: x.author_label ?? 'Attendly',
      institutions: x.institutions,
      recipients: x.recipients,
      seen: x.seen,
      important: x.important,
      createdAt: x.created_at.toISOString(),
    }));
  });

  /** Take a broadcast back: it disappears from every institution's notices. */
  app.post('/v1/root/broadcasts/:id/withdraw', async (req) => {
    const r = await requireRoot(req, deps);
    noSandbox(r, 'withdrawing a broadcast');
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const n = await withTx(deps.db, async (tx) => {
      const res = await tx.query(`update notices set deleted_at = $2 where broadcast_id = $1 and platform and deleted_at is null`, [id, new Date(deps.clock())]);
      await appendAudit(tx, { tenantId: null, actorType: 'user', actorId: r.userId, action: 'root.broadcast_withdraw', subject: `broadcast:${id}`, data: { notices: res.rowCount ?? 0 } });
      return res.rowCount ?? 0;
    });
    if (!n) throw new ApiError(404, 'NOT_FOUND', 'Broadcast not found.');
    return { ok: true, withdrawn: n };
  });
}
