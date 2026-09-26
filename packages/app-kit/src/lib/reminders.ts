/**
 * Class reminders: local notifications scheduled on the phone before each upcoming class
 * ("CS-301 in 15 min · 10:00 AM · LH-2"). They fire on time even offline. Everyone picks
 * how long before (several at once is fine). Re-planned whenever the timetable changes.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { vault } from './vault';

export const REMINDER_CHOICES = [5, 10, 15, 30, 60, 1440] as const;
export const reminderLabel = (m: number) => (m >= 1440 ? 'a day before' : m >= 60 ? `${m / 60} hour before` : `${m} min before`);

export interface ReminderSettings {
  enabled: boolean;
  minutes: number[];
}
const DEFAULTS: ReminderSettings = { enabled: true, minutes: [15] };
const KEY = 'reminders.settings.v1';
const SIG_KEY = 'reminders.signature.v1';
const MAX_SCHEDULED = 60;

let settings: ReminderSettings = DEFAULTS;
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const s = await vault.get<ReminderSettings>(KEY, (v) => {
      const o = v as ReminderSettings;
      return { enabled: o?.enabled !== false, minutes: Array.isArray(o?.minutes) ? o.minutes.filter((m) => REMINDER_CHOICES.includes(m as never)) : DEFAULTS.minutes };
    });
    if (s) settings = s;
  } catch {
    // defaults
  }
  emit();
}

export function useReminderSettings(): ReminderSettings {
  useEffect(() => void load(), []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => settings,
  );
}

export async function saveReminderSettings(next: ReminderSettings): Promise<void> {
  settings = { enabled: next.enabled, minutes: [...new Set(next.minutes)].sort((a, b) => a - b) };
  emit();
  await vault.set(KEY, settings).catch(() => undefined);
  await vault.remove(SIG_KEY).catch(() => undefined); // force a re-plan
}

export interface ReminderClass {
  sessionId: string;
  courseId?: string;
  title: string; // "CS-301 · Operating Systems"
  start: string; // ISO
  timeLabel: string; // "10:00 AM"
  where: string | null;
  cancelled?: boolean;
}

/** Replaces every scheduled class reminder with fresh ones for these classes (next 7 days). */
export async function planReminders(classes: ReminderClass[], s: ReminderSettings, nowMs: number): Promise<number> {
  if (Platform.OS === 'web') return 0;
  const upcoming = classes.filter((c) => !c.cancelled && Date.parse(c.start) > nowMs && Date.parse(c.start) < nowMs + 8 * 86_400_000);
  const sig = JSON.stringify([s, upcoming.map((c) => [c.sessionId, c.start, c.where])]);
  try {
    if ((await vault.get<string>(SIG_KEY, (v) => String(v))) === sig) return -1;
    if ((await Notifications.getPermissionsAsync()).status !== 'granted') return 0;
    for (const n of await Notifications.getAllScheduledNotificationsAsync())
      if ((n.content.data as { kind?: string } | undefined)?.kind === 'reminder') await Notifications.cancelScheduledNotificationAsync(n.identifier);
    let count = 0;
    if (s.enabled)
      outer: for (const c of upcoming.sort((a, b) => a.start.localeCompare(b.start)))
        for (const m of s.minutes) {
          const at = Date.parse(c.start) - m * 60_000;
          if (at <= nowMs + 5_000) continue;
          if (count >= MAX_SCHEDULED) break outer;
          await Notifications.scheduleNotificationAsync({
            content: {
              title: `${c.title} · ${m >= 1440 ? 'tomorrow' : m >= 60 ? `in ${m / 60} h` : `in ${m} min`}`,
              body: `${c.timeLabel}${c.where ? ` · ${c.where}` : ''}`,
              data: { kind: 'reminder', sessionId: c.sessionId, courseId: c.courseId },
              sound: 'default',
            },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at), ...(Platform.OS === 'android' ? { channelId: 'timetable-alerts' } : {}) },
          });
          count++;
        }
    await vault.set(SIG_KEY, sig);
    return count;
  } catch {
    return 0;
  }
}

/** Keeps reminders in step with the classes the app currently knows about. */
export function useClassReminders(classes: ReminderClass[] | null, nowMs: number): void {
  const s = useReminderSettings();
  const key = classes ? JSON.stringify(classes.map((c) => [c.sessionId, c.start, c.where, c.cancelled])) : null;
  useEffect(() => {
    if (!classes || !loaded) return;
    void planReminders(classes, s, nowMs);
    // nowMs changes every render; re-plan only when the classes or settings change.
  }, [key, s]); // eslint-disable-line react-hooks/exhaustive-deps
}
