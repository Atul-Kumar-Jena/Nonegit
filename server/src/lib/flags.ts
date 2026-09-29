/**
 * Platform kill switches (system_flags, set by a developer) and per-institution feature
 * flags (tenant_flags). Every switch listed here is enforced on the server.
 */
import type { Queryable } from '../db';

export const SWITCHES = {
  scans_paused: { label: 'Pause all incoming marks', detail: 'Every scan is refused with “Scanning paused”. Registers still work.' },
  sign_ins_paused: { label: 'Pause sign-ins', detail: 'No new sign-in codes (developers excepted). People already signed in carry on.' },
  new_bindings_blocked: { label: 'Reject new phone bindings', detail: 'Nobody can bind a new phone until this is off.' },
  hardware_checks_relaxed: {
    label: 'Relax phone hardware checks (emergency)',
    detail: 'Phones whose secure-hardware check fails may still bind. Use only if a phone model is wrongly refused.',
  },
  phone_rules_off: {
    label: 'Testing: phone rules off',
    detail:
      'Nobody is stopped by phone binding: one phone can hold several accounts, a new phone takes over without admin approval, and the security-chip check never refuses. Every takeover is recorded. Turn off before real use.',
  },
  demo_login_off: { label: 'Turn off one-tap demo sign-in', detail: 'Demo accounts need a sign-in code like everyone else.' },
  notifications_paused: {
    label: 'Pause phone notifications',
    detail: 'Nothing is pushed to phones (e.g. a flood of alerts). Notifications still appear in the apps’ bell.',
  },
} as const;
export type SwitchKey = keyof typeof SWITCHES;

export const TENANT_FLAGS = {
  strict_geo: { label: 'Strict geofence', detail: 'No ±accuracy allowance: a scan must be inside the room’s radius itself.', default: false },
  student_requests: { label: 'Students can ask teachers', detail: 'The “Ask” button on the students’ timetable.', default: true },
  offline_scans_off: {
    label: 'Refuse offline scans',
    detail: 'Scans must reach the server within seconds. For campuses with reliable internet; stops any use of old QR codes.',
    default: false,
  },
  manual_registers: { label: 'Paper-style registers', detail: 'Teachers may mark attendance by ticking names.', default: true },
} as const;
export type TenantFlagKey = keyof typeof TENANT_FLAGS;

export async function switchOn(db: Queryable, key: SwitchKey): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>('select enabled from system_flags where key = $1', [key]);
  return rows[0]?.enabled ?? false;
}

/** A flag's value where an institution hasn't set it. */
export function flagDefault(key: TenantFlagKey, _config?: unknown): boolean {
  return TENANT_FLAGS[key].default;
}

export async function tenantFlag(db: Queryable, tenantId: string, key: TenantFlagKey, config?: { attestation: { strictByDefault: boolean } }): Promise<boolean> {
  const { rows } = await db.query<{ enabled: boolean }>('select enabled from tenant_flags where tenant_id = $1 and key = $2', [tenantId, key]);
  return rows[0]?.enabled ?? flagDefault(key, config);
}
