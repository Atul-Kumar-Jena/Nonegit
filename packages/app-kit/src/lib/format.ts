/** Formatting helpers. Pure functions, no locale surprises in the security-relevant parts. */

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function initials(name: string): string {
  const parts = name
    .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[parts.length - 1]![0]! : '';
  return (a + b).toUpperCase();
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** Wall-clock parts of `iso` in an IANA timezone (falls back to device time if unsupported). */
export function zoned(iso: string | number, timeZone?: string) {
  const d = new Date(iso);
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
    const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return {
      y: Number(parts.year),
      m: Number(parts.month) - 1,
      d: Number(parts.day),
      hm: `${hour}:${parts.minute}`,
      dow: String(parts.weekday ?? '').toUpperCase().slice(0, 3),
    };
  } catch {
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), hm: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, dow: DAYS[d.getDay()]! };
  }
}

export function dayLabel(iso: string | number, timeZone?: string): string {
  const z = zoned(iso, timeZone);
  return `${z.dow} ${z.d} ${MONTHS[z.m]!.toUpperCase()}`;
}

/** "14:05" → "2:05 PM" (for display; logic keeps 24-hour strings). */
export function to12h(hm: string): string {
  const [h = 0, m = 0] = hm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** A time for people to read: "2:05 PM". */
export function clock(iso: string | number, timeZone?: string): string {
  return to12h(zoned(iso, timeZone).hm);
}

export function timeRange(startIso: string, endIso: string, timeZone?: string): string {
  return `${clock(startIso, timeZone)} – ${clock(endIso, timeZone)}`;
}

export function dateLong(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** 2026-05-16 10:14:38 UTC */
export function utcStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : dateLong(iso);
}

export function shortFingerprint(fp: string): string {
  const [a, , c] = fp.split('-');
  return a && c ? `${a}…${c}` : fp;
}

export function drift(ms: number | null): string {
  if (ms === null) return '—';
  const abs = Math.abs(ms);
  const sign = ms >= 0 ? '+' : '−';
  return abs < 1000 ? `${sign}${Math.round(abs)}ms` : `${sign}${(abs / 1000).toFixed(1)}s`;
}
