import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { CreateSessionBody, type SessionMode } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Button, Notice, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { staffApi } from '@/api';
import { Chips, DateField, Field, Header, Select, TimeField, firstIssue, fromMinutes, toMinutes } from '@/components/forms';
import { useCourses, useOverview, useRooms } from '@/queries';
import { BatchCoursePicker } from '@/components/BatchCoursePicker';
import { ScheduleHints } from '@/components/ScheduleHints';
import { ymdIn } from '@/time';

/** A one-off class that isn't on the weekly timetable (extra lecture, make-up lab…). */
export default function ExtraClass() {
  const params = useLocalSearchParams<{ courseId?: string; date?: string; start?: string; end?: string; roomId?: string; teacherId?: string; teacherName?: string }>();
  const initialCourse = params.courseId;
  const api = useApi();
  const qc = useQueryClient();
  const courses = useCourses();
  const rooms = useRooms();
  const overview = useOverview();
  const tz = overview.data?.timezone;
  const nowMin = (() => {
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(api.serverNow()));
    const m = toMinutes(hm.replace('24:', '00:'));
    return m - (m % 5);
  })();

  const [courseId, setCourseId] = useState<string | null>(initialCourse ?? null);
  const [date, setDate] = useState(() => params.date ?? ymdIn(api.serverNow(), tz));
  const [start, setStart] = useState(() => params.start ?? fromMinutes(nowMin));
  const [end, setEnd] = useState(() => params.end ?? fromMinutes(Math.min(nowMin + 60, 23 * 60 + 55)));
  const [roomId, setRoomId] = useState<string | null>(params.roomId ?? null);
  const teacherId = params.teacherId ?? null;
  const [mode, setMode] = useState<SessionMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const course = courses.data?.find((c) => c.id === courseId);
  const m = mode ?? course?.defaultMode ?? 'qr';

  async function save() {
    setError(null);
    const parsed = CreateSessionBody.safeParse({ courseId, date, start, end, roomId, mode: m });
    if (!courseId) return setError('Choose the batch and subject.');
    if (!parsed.success) return setError(firstIssue(parsed.error));
    setBusy(true);
    try {
      const s = await staffApi.createSession(api, parsed.data);
      void qc.invalidateQueries({ queryKey: ['staff'] });
      router.replace({ pathname: '/session/[id]', params: { id: s.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t add the class.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard>
      <Header title="Extra class" />
      <Text variant="small">For a class that isn’t on the weekly timetable. Students see it on their timetable straight away.</Text>
      {teacherId ? <Notice tone="green" message={`Scheduling for ${params.teacherName ?? 'this professor'} — free at this time. Their subjects are listed.`} /> : null}
      <BatchCoursePicker courseId={courseId} onChange={(v) => setCourseId(v)} activeOnly teacherId={teacherId} />
      <Field label="Date">
        <DateField value={date} onChange={setDate} />
      </Field>
      <Field label="Starts">
        <TimeField label="Start" value={start} onChange={(v) => { setStart(v); if (toMinutes(v) >= toMinutes(end)) setEnd(fromMinutes(Math.min(toMinutes(v) + 60, 23 * 60 + 55))); }} />
      </Field>
      <Field label="Ends" error={toMinutes(end) <= toMinutes(start) ? 'Must be after the start time' : null}>
        <TimeField label="End" value={end} onChange={setEnd} />
      </Field>
      <Field label="Room" hint="QR classes use the room’s saved location if you don’t use your phone’s.">
        <Select title="Room" value={roomId} onChange={setRoomId} allowNone="No room" options={(rooms.data ?? []).filter((r) => r.active).map((r) => ({ value: r.id, label: r.name, sub: r.lat !== null ? `Location saved · ${r.radiusM} m` : 'No location saved' }))} />
      </Field>
      <ScheduleHints date={date} start={start} end={end} teacherId={course?.instructor?.id ?? null} teacherName={course?.instructor?.name ?? null} roomId={roomId} onRoom={setRoomId} />
      <Field label="Attendance by">
        <Chips value={m} options={[{ value: 'qr', label: 'QR scan' }, { value: 'manual', label: 'Register' }]} onChange={setMode} />
      </Field>
      {error ? <Notice tone="red" message={error} /> : null}
      <Button title="Add class" onPress={() => void save()} loading={busy} style={{ marginTop: 20 }} />
    </Screen>
  );
}
