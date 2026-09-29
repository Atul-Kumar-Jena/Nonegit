import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react-native';
import { SlotBody, type SessionMode } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Button, Card, Loading, Notice, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { Chips, DateField, Field, Header, Select, TimeField, ToggleRow, WEEKDAYS, WEEKDAY_NAME, confirmAction, firstIssue, fromMinutes, toMinutes } from '@/components/forms';
import { useCourses, useOverview, useRooms, useTimetable } from '@/queries';
import { BatchCoursePicker } from '@/components/BatchCoursePicker';
import { ymdIn } from '@/time';

const ROTATIONS = [
  { value: 3, label: '3 s' },
  { value: 5, label: '5 s' },
  { value: 7, label: '7 s' },
  { value: 10, label: '10 s' },
] as const;

/** Add or edit a weekly timetable slot (admins). Saving updates every app within seconds. */
export default function SlotForm() {
  const params = useLocalSearchParams<{ id?: string; weekday?: string; courseId?: string }>();
  const id = params.id ? String(params.id) : null;
  const api = useApi();
  const qc = useQueryClient();
  const slots = useTimetable();
  const courses = useCourses();
  const rooms = useRooms();
  const tz = useOverview().data?.timezone;
  const existing = id ? slots.data?.find((s) => s.id === id) : undefined;

  const [courseId, setCourseId] = useState<string | null>(params.courseId ? String(params.courseId) : null);
  const [weekday, setWeekday] = useState<number>(() => {
    const w = Number(params.weekday);
    return Number.isInteger(w) && w >= 0 && w <= 6 ? w : 1;
  });
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [mode, setMode] = useState<SessionMode>('qr');
  const [rotationS, setRotation] = useState(5);
  const [validFrom, setValidFrom] = useState(() => ymdIn(api.serverNow(), tz));
  const [hasEnd, setHasEnd] = useState(false);
  const [validUntil, setValidUntil] = useState(() => ymdIn(api.serverNow() + 120 * 86_400_000, tz));
  const [active, setActive] = useState(true);
  const [loaded, setLoaded] = useState(!id);
  const [busy, setBusy] = useState<null | 'save' | 'delete'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!existing || loaded) return;
    setCourseId(existing.courseId);
    setWeekday(existing.weekday);
    setStart(existing.start);
    setEnd(existing.end);
    setRoomId(existing.room?.id ?? null);
    setMode(existing.mode);
    setRotation(existing.rotationS);
    setValidFrom(existing.validFrom);
    setHasEnd(!!existing.validUntil);
    if (existing.validUntil) setValidUntil(existing.validUntil);
    setActive(existing.active);
    setLoaded(true);
  }, [existing, loaded]);

  // New slot: follow the course's default attendance method.
  useEffect(() => {
    if (id) return;
    const c = courses.data?.find((x) => x.id === courseId);
    if (c) setMode(c.defaultMode);
  }, [courseId, courses.data, id]);

  if (id && !loaded) return <Screen scroll={false}><Header title="Timetable slot" />{slots.isPending ? <Loading /> : <Notice tone="red" message="This slot no longer exists." />}</Screen>;

  async function save() {
    setError(null);
    if (!courseId) return setError('Choose the batch and subject.');
    const parsed = SlotBody.safeParse({ courseId, weekday, start, end, roomId, mode, rotationS, validFrom, validUntil: hasEnd ? validUntil : null, active });
    if (!parsed.success) return setError(firstIssue(parsed.error));
    if (hasEnd && validUntil < validFrom) return setError('The last date must be after the first date.');
    setBusy('save');
    try {
      await staffApi.saveSlot(api, id, parsed.data);
      void qc.invalidateQueries({ queryKey: ['staff'] });
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save.');
    } finally {
      setBusy(null);
    }
  }

  function remove() {
    confirmAction('Delete this slot?', 'Future classes from this slot are removed from every app. Past classes and their attendance are kept.', 'Delete', async () => {
      setBusy('delete');
      try {
        await staffApi.deleteSlot(api, id!);
        void qc.invalidateQueries({ queryKey: ['staff'] });
        router.back();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Couldn’t delete.');
      } finally {
        setBusy(null);
      }
    }, true);
  }

  return (
    <Screen keyboard>
      <Header title={id ? 'Edit slot' : 'New weekly slot'} />
      <BatchCoursePicker courseId={courseId} onChange={(v) => setCourseId(v)} />
      <Field label="Day">
        <Chips value={weekday} options={WEEKDAYS} onChange={setWeekday} />
      </Field>
      <Field label="Starts">
        <TimeField label="Start" value={start} onChange={(v) => { setStart(v); if (toMinutes(v) >= toMinutes(end)) setEnd(fromMinutes(Math.min(toMinutes(v) + 60, 23 * 60 + 55))); }} />
      </Field>
      <Field label="Ends" error={toMinutes(end) <= toMinutes(start) ? 'Must be after the start time' : null}>
        <TimeField label="End" value={end} onChange={setEnd} />
      </Field>
      <Field label="Room" hint="A room can’t be booked twice at the same time.">
        <Select title="Room" value={roomId} onChange={setRoomId} allowNone="No room" options={(rooms.data ?? []).filter((r) => r.active).map((r) => ({ value: r.id, label: r.name, sub: r.lat !== null ? `Location saved · ${r.radiusM} m` : 'No location saved' }))} />
      </Field>
      <Field label="Attendance by">
        <Chips value={mode} options={[{ value: 'qr', label: 'QR scan' }, { value: 'manual', label: 'Paper-style register' }]} onChange={setMode} />
      </Field>
      {mode === 'qr' ? (
        <Field label="QR changes every">
          <Chips value={rotationS} options={ROTATIONS} onChange={setRotation} />
        </Field>
      ) : null}
      <Field label="First week">
        <DateField value={validFrom} onChange={setValidFrom} />
      </Field>
      <Card style={{ marginTop: 16, gap: 10 }}>
        <ToggleRow label="Ends on a date" hint="Leave off to repeat all term." value={hasEnd} onChange={setHasEnd} />
        {hasEnd ? <DateField value={validUntil} onChange={setValidUntil} /> : null}
        <ToggleRow label="Active" hint="Pause a slot without deleting it." value={active} onChange={setActive} />
      </Card>
      <Text variant="small" style={{ marginTop: 12 }}>
        Every {WEEKDAY_NAME[weekday]} {start}–{end}. Classes are created 14 days ahead and appear in every app.
      </Text>
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      <Button title={id ? 'Save changes' : 'Add to timetable'} onPress={() => void save()} loading={busy === 'save'} style={{ marginTop: 18 }} />
      {id ? <Button title="Delete slot" kind="danger" onPress={remove} loading={busy === 'delete'} icon={<Trash2 color={colors.red} size={16} />} style={{ marginTop: 10 }} /> : null}
    </Screen>
  );
}
