/** Reading typed times and dates (no React Native here, so it is unit-tested in Node). */
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Reads a typed time: "10:30", "1030", "10.30", "9", "2:05 pm", "14:05". Without am/pm, hours 1–12
 * follow `pm`; 0 and 13–23 are 24-hour. Returns "HH:MM" or null.
 */
export function parseTime(text: string, pm: boolean): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  const m = /^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm|a|p)?$/.exec(t) ?? /^(\d)(\d{2})(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (min > 59 || h > 23) return null;
  const suffix = m[3];
  if (suffix) {
    if (h < 1 || h > 12) return null;
    const isPm = suffix.startsWith('p');
    h = (h % 12) + (isPm ? 12 : 0);
  } else if (h >= 1 && h <= 12) h = (h % 12) + (pm ? 12 : 0);
  return `${pad(h)}:${pad(min)}`;
}

/** Reads "27/09/2026", "27-9-26", "27 9" (this year) or "2026-09-27". Returns "YYYY-MM-DD" or null. */
export function parseDate(text: string, fallbackYear: number): string | null {
  const t = text.trim();
  let y: number, mo: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const dmy = /^(\d{1,2})[/.\-\s](\d{1,2})(?:[/.\-\s](\d{2,4}))?$/.exec(t);
  if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [d, mo, y] = [Number(dmy[1]), Number(dmy[2]), dmy[3] ? Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]) : fallbackYear];
  else return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return ymd(dt);
}

