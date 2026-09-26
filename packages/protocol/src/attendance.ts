/** Attendance maths — shared so every app shows identical numbers. */

/** Percentage with one decimal, or null when nothing has been held yet. */
export function attendancePercent(attended: number, held: number): number | null {
  if (!(held > 0)) return null;
  const pct = (Math.min(attended, held) / held) * 100;
  return Math.round(pct * 10) / 10;
}

/**
 * How many consecutive sessions must be attended to reach `minPercent`.
 * 0 when already at or above the threshold.
 */
export function sessionsNeededToReach(attended: number, held: number, minPercent: number): number {
  const m = minPercent / 100;
  if (held === 0 || attended / held >= m) return 0;
  if (m >= 1) return Number.POSITIVE_INFINITY;
  // (a + y) / (h + y) >= m  =>  y >= (m·h − a) / (1 − m)
  return Math.max(0, Math.ceil((m * held - attended) / (1 - m) - 1e-9));
}

/** How many upcoming sessions can be missed while staying at or above `minPercent`. */
export function sessionsSafeToMiss(attended: number, held: number, minPercent: number): number {
  const m = minPercent / 100;
  if (m <= 0) return Number.POSITIVE_INFINITY;
  // a / (h + x) >= m  =>  x <= a/m − h
  return Math.max(0, Math.floor(attended / m - held + 1e-9));
}

export type AttendanceStanding = 'no-data' | 'safe' | 'at-risk';

export function standing(attended: number, held: number, minPercent: number): AttendanceStanding {
  const pct = attendancePercent(attended, held);
  if (pct === null) return 'no-data';
  return (attended / held) * 100 >= minPercent ? 'safe' : 'at-risk';
}
