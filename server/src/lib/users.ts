import { keyFingerprint, type DeviceSummary, type Platform, type Role, type UserSummary } from '@attendly/protocol';
import { ApiError } from './errors';
import { isDemoEmail } from './demo';
import type { Queryable } from '../db';

export interface UserRow {
  id: string;
  tenant_id: string;
  role: Role;
  full_name: string;
  email: string | null;
  phone: string | null;
  roll_no: string | null;
  department: string | null;
  semester: number | null;
  status: 'active' | 'suspended';
  tenant_slug: string;
  tenant_name: string;
  tenant_code: string;
  tenant_status: 'active' | 'suspended';
}

export async function loadUser(db: Queryable, userId: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>(
    `select u.id, u.tenant_id, u.role, u.full_name, u.email, u.phone, u.roll_no, u.department, u.semester, u.status,
            t.slug as tenant_slug, t.name as tenant_name, t.code as tenant_code, t.status as tenant_status
       from users u join tenants t on t.id = u.tenant_id where u.id = $1`,
    [userId],
  );
  return rows[0];
}

export function toUserSummary(u: UserRow): UserSummary {
  return {
    id: u.id,
    role: u.role,
    fullName: u.full_name,
    email: u.email,
    phone: u.phone,
    rollNo: u.roll_no,
    department: u.department,
    semester: u.semester,
    institution: { slug: u.tenant_slug, name: u.tenant_name, code: u.tenant_code },
  };
}

export interface DeviceRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  fingerprint: string;
  platform: Platform;
  model: string;
  os_version: string;
  app_version: string;
  status: 'active' | 'revoked';
  bound_at: Date | null;
  last_seen_at: Date | null;
  hw_hash: Buffer | null;
  hw_key_spki?: Buffer | null;
  attest_level?: 'tee' | 'strongbox' | null;
}

/** Keyed hash of a phone's hardware ID (the raw ID is never stored). */
export function hardwareHash(hash: (purpose: string, value: string) => Buffer, info: { platform: string; hardwareId?: string }): Buffer | null {
  return info.hardwareId ? hash('hw', `${info.platform}:${info.hardwareId}`) : null;
}

/**
 * One phone, one account: a phone (its hardware ID) already bound to someone else can't be bound to
 * another account — whatever the roles. Developers are exempt (the platform owner tests with their
 * own phone), and so are demo accounts on a demo server, except two demo students.
 */
export async function assertPhoneFree(db: Queryable, hw: Buffer | null, user: { id: string; role: string; email: string | null }, demo: boolean): Promise<void> {
  if (!hw || user.role === 'developer') return;
  const { rows } = await db.query<{ role: string; email: string | null }>(
    `select u.role, u.email from devices d join users u on u.id = d.user_id
      where d.hw_hash = $1 and d.status = 'active' and d.user_id <> $2 and u.role <> 'developer' limit 10`,
    [hw, user.id],
  );
  for (const o of rows) {
    const bothStudents = o.role === 'student' && user.role === 'student';
    if (demo && isDemoEmail(o.email) && isDemoEmail(user.email) && !bothStudents) continue;
    throw new ApiError(
      409,
      'CONFLICT',
      bothStudents
        ? 'This phone is already registered to another student. One phone, one student — ask your admin to unbind it from the other account first.'
        : 'This phone is already registered to another Attendly account. One phone, one account — ask your admin to unbind it from the other account first.',
    );
  }
}

export async function loadActiveDevice(db: Queryable, userId: string): Promise<DeviceRow | undefined> {
  const { rows } = await db.query<DeviceRow>(`select * from devices where user_id = $1 and status = 'active'`, [userId]);
  return rows[0];
}

export async function loadDevice(db: Queryable, deviceId: string): Promise<DeviceRow | undefined> {
  const { rows } = await db.query<DeviceRow>(`select * from devices where id = $1`, [deviceId]);
  return rows[0];
}

export function toDeviceSummary(d: DeviceRow): DeviceSummary {
  return {
    id: d.id,
    platform: d.platform,
    model: d.model,
    osVersion: d.os_version,
    fingerprint: d.fingerprint || keyFingerprint(d.public_key),
    status: d.status,
    boundAt: d.bound_at ? d.bound_at.toISOString() : null,
    lastSeenAt: d.last_seen_at ? d.last_seen_at.toISOString() : null,
    hardware: d.hw_key_spki && d.attest_level ? d.attest_level : 'none',
  };
}
