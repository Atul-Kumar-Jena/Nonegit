import { useMemo } from 'react';
import { clock } from '@kit/lib/format';
import { useClassReminders, type ReminderClass } from '@kit/lib/reminders';
import { useApi } from '@kit/state/session';
import { useMe, useOverview, useSessionsOn } from '@/queries';
import { ymdIn } from '@/time';

/** Reminders for the classes this person teaches (or covers) in the next week. */
export function ReminderRunner() {
  const api = useApi();
  const me = useMe();
  const tz = useOverview().data?.timezone;
  const q = useSessionsOn(ymdIn(api.serverNow(), tz), 8);
  const meId = me.data?.user.id;
  const classes = useMemo<ReminderClass[] | null>(
    () =>
      q.data && meId
        ? q.data
            .filter((s) => (s.substitute?.id ?? s.teacher?.id) === meId)
            .map((s) => ({
              sessionId: s.id,
              courseId: s.courseId,
              title: `${s.courseCode} · ${s.courseTitle}`,
              start: s.scheduledStart,
              timeLabel: clock(s.scheduledStart, tz),
              where: s.roomLabel,
              cancelled: s.status === 'cancelled' || s.status === 'closed',
            }))
        : null,
    [q.data, meId, tz],
  );
  useClassReminders(classes, api.serverNow());
  return null;
}
