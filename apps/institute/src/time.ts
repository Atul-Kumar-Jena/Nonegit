import { zoned } from '@kit/lib/format';

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" for a moment, in the institution's time zone. */
export function ymdIn(ms: number, tz?: string): string {
  const z = zoned(ms, tz);
  return `${z.y}-${pad(z.m + 1)}-${pad(z.d)}`;
}

/** Classes can be started up to 2 h early (server rule) and until they end. */
export const EARLY_START_MS = 2 * 60 * 60_000;
/** Teachers can change a register up to 14 days after class (admins any time). */
export const TEACHER_EDIT_WINDOW_MS = 14 * 24 * 60 * 60_000;

export function canStartNow(s: { status: string; scheduledStart: string; scheduledEnd: string }, now: number): boolean {
  return s.status === 'scheduled' && now >= Date.parse(s.scheduledStart) - EARLY_START_MS && now <= Date.parse(s.scheduledEnd);
}

export function minutesLabel(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (Math.abs(m) < 60) return `${m} min`;
  const h = Math.floor(Math.abs(m) / 60);
  const r = Math.abs(m) % 60;
  return `${h} h${r ? ` ${r} min` : ''}`;
}
