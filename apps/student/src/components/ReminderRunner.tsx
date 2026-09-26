import { useMemo } from 'react';
import { clock } from '@kit/lib/format';
import { useClassReminders, type ReminderClass } from '@kit/lib/reminders';
import { useApi } from '@kit/state/session';
import { useTimetable } from '@/state/queries';

/** Keeps the phone's class reminders in step with the timetable. */
export function ReminderRunner() {
  const api = useApi();
  const t = useTimetable();
  const classes = useMemo<ReminderClass[] | null>(
    () =>
      t.data
        ? t.data.upcoming.map((u) => ({
            sessionId: u.sessionId,
            courseId: u.courseId,
            title: `${u.courseCode} · ${u.courseTitle}`,
            start: u.scheduledStart,
            timeLabel: clock(u.scheduledStart, t.data!.timezone),
            where: u.room,
            cancelled: u.status === 'cancelled',
          }))
        : null,
    [t.data],
  );
  useClassReminders(classes, api.serverNow());
  return null;
}
