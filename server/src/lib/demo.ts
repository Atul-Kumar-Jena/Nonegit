import type { Db } from '../db';

/** Accounts of the seeded demo institute. Only these may hop between phones in demo mode. */
export const DEMO_DOMAIN = 'demo.attendly.app';

export function isDemoEmail(email: string | null | undefined): boolean {
  return !!email && email.endsWith(`@${DEMO_DOMAIN}`);
}

export interface DemoAccount {
  role: 'student' | 'teacher' | 'admin' | 'developer';
  name: string;
  email: string;
  title: string;
}

const ROLE_ORDER = { admin: 0, teacher: 1, developer: 2, student: 3 } as const;

let cache: { at: number; value: { institution: string | null; institutionCode: string | null; accounts: DemoAccount[] } } | null = null;

/** The demo institute's sign-in list (for the "tap to sign in" buttons). Cached for a minute. */
export async function listDemoAccounts(db: Db, now: number): Promise<{ institution: string | null; institutionCode: string | null; accounts: DemoAccount[] }> {
  if (cache && now - cache.at < 60_000) return cache.value;
  const { rows } = await db.query<{ role: DemoAccount['role']; full_name: string; email: string; roll_no: string | null; tenant: string; code: string; courses: string[] | null }>(
    `select u.role, u.full_name, u.email, u.roll_no, t.name as tenant, t.code,
            (select array_agg(c.code order by c.code) from courses c where c.instructor_id = u.id and c.active) as courses
       from users u join tenants t on t.id = u.tenant_id
      where u.email like $1 and u.status = 'active' and t.status = 'active' and t.slug = 'demo'
      order by u.email`,
    [`%@${DEMO_DOMAIN}`],
  );
  const accounts = rows
    .map((r) => ({
      role: r.role,
      name: r.full_name,
      email: r.email,
      title:
        r.role === 'admin'
          ? r.courses?.length
            ? `Admin · HOD · teaches ${r.courses.join(', ')}`
            : 'Admin · Principal'
          : r.role === 'teacher'
            ? `Teacher${r.courses?.length ? ` · ${r.courses.join(', ')}` : ''}`
            : r.role === 'developer'
              ? 'Developer · root console'
              : `Student${r.roll_no ? ` · ${r.roll_no}` : ''}`,
    }))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
    .slice(0, 40);
  const value = { institution: rows[0]?.tenant ?? null, institutionCode: rows[0]?.code ?? null, accounts };
  cache = { at: now, value };
  return value;
}

export function clearDemoCache(): void {
  cache = null;
}
