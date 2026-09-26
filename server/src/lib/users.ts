import { keyFingerprint, type DeviceSummary, type Platform, type Role, type UserSummary } from '@attendly/protocol';
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
  tenant_status: 'active' | 'suspended';
}

export async function loadUser(db: Queryable, userId: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>(
    `select u.id, u.tenant_id, u.role, u.full_name, u.email, u.phone, u.roll_no, u.department, u.semester, u.status,
            t.slug as tenant_slug, t.name as tenant_name, t.status as tenant_status
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
    institution: { slug: u.tenant_slug, name: u.tenant_name },
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
  };
}
