import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, XOctagon } from 'lucide-react-native';
import type { DraftOp, PlannerConflict, OpError, PublishResponse, StaffSession } from '@attendly/protocol';
import { Badge, Button, Card, Input, Loading, Notice, Text } from '@kit/components/ui';
import { zoned } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { useAvailability, useRooms } from '@/queries';
import { ymdIn } from '@/time';
import { DateField, Field, Select, Sheet, TimeField, fromMinutes, toMinutes } from './forms';

/** Clashes and problems returned by the server (or the local engine), in plain words. */
export function ConflictList({ conflicts, errors }: { conflicts: PlannerConflict[]; errors: OpError[] }) {
  if (!conflicts.length && !errors.length) return null;
  return (
    <View style={{ gap: 8 }}>
      {errors.map((e, i) => (
        <View key={`e${i}`} style={styles.line}>
          <XOctagon color={colors.red} size={15} />
          <Text variant="small" color={colors.text} style={{ flex: 1 }}>
            {e.message}
          </Text>
        </View>
      ))}
      {conflicts.map((c, i) => (
        <View key={`c${i}`} style={styles.line}>
          {c.severity === 'error' ? <XOctagon color={colors.red} size={15} /> : <AlertTriangle color={colors.amber} size={15} />}
          <Text variant="small" color={colors.text} style={{ flex: 1 }}>
            {c.message}
          </Text>
        </View>
      ))}
    </View>
  );
}

const overlaps = (aS: string, aE: string, bS: string, bE: string) => aS < bE && bS < aE;

/** Pick a teacher for a given time, showing who is free and who is busy (and where). */
export function TeacherPicker({
  date,
  start,
  end,
  value,
  onChange,
  excludeSessionId,
  courseTeacherId,
}: {
  date: string;
  start: string;
  end: string;
  value: string | null;
  onChange: (id: string | null) => void;
  excludeSessionId?: string;
  courseTeacherId: string | null;
}) {
  const avail = useAvailability(date);
  const rows = useMemo(() => {
    return (avail.data?.teachers ?? [])
      .map((t) => {
        const clash = t.busy.find((b) => b.sessionId !== excludeSessionId && b.date === date && overlaps(start, end, b.start, b.end));
        return { ...t, clash };
      })
      .sort((a, b) => Number(!!a.clash) - Number(!!b.clash) || a.name.localeCompare(b.name));
  }, [avail.data, date, start, end, excludeSessionId]);
  if (avail.isPending) return <Loading />;
  return (
    <View style={{ gap: 6 }}>
      {rows.map((t) => {
        const on = value === t.id || (value === null && t.id === courseTeacherId);
        return (
          <Pressable key={t.id} onPress={() => onChange(t.id === courseTeacherId ? null : t.id)} accessibilityRole="radio" accessibilityState={{ selected: on }} style={[styles.teacher, on && styles.teacherOn]}>
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">
                {t.name}
                {t.id === courseTeacherId ? <Text variant="small"> · course teacher</Text> : null}
              </Text>
              <Text variant="small" color={t.clash ? colors.amber : colors.green}>
                {t.clash ? `Busy: ${t.clash.courseCode} ${t.clash.start}–${t.clash.end}${t.clash.room ? ` · ${t.clash.room}` : ''}` : 'Free at this time'}
              </Text>
            </View>
            {on ? <CheckCircle2 color={colors.cyan} size={18} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

type Mode = 'reschedule' | 'substitute' | 'cancel';

/**
 * Changes one class right away (the teacher's "adjustment"): move it, give it to
 * another teacher, or cancel it with a reason. Students are notified on success.
 */
export function AdjustSheet({ session: s, tz, mode, onClose }: { session: StaffSession; tz?: string; mode: Mode | null; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const rooms = useRooms();
  const startMs = Date.parse(s.scheduledStart);
  const [date, setDate] = useState(() => ymdIn(startMs, tz));
  const [start, setStart] = useState(() => zoned(s.scheduledStart, tz).hm);
  const [end, setEnd] = useState(() => zoned(s.scheduledEnd, tz).hm);
  const [roomId, setRoomId] = useState<string | null>(s.room?.id ?? null);
  const [teacherId, setTeacherId] = useState<string | null>(s.substitute?.id ?? null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!mode) return null;
  const change: DraftOp =
    mode === 'reschedule'
      ? { op: 'reschedule', sessionId: s.id, date, start, end, roomId }
      : mode === 'substitute'
        ? { op: 'substitute', sessionId: s.id, teacherId }
        : { op: 'cancel', sessionId: s.id, reason: reason.trim() };
  const invalid = (mode === 'reschedule' && toMinutes(end) <= toMinutes(start)) || (mode === 'cancel' && reason.trim().length < 3);
  const onlyWarnings = !!result && !result.published && result.errors.length === 0 && result.conflicts.length > 0 && result.conflicts.every((c) => c.severity === 'warning');

  async function submit(acceptWarnings: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await staffApi.adjust(api, s.id, change, acceptWarnings);
      setResult(r);
      if (r.published) {
        void qc.invalidateQueries({ queryKey: ['staff'] });
        setTimeout(onClose, 1400);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the change.');
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'reschedule' ? 'Move this class' : mode === 'substitute' ? 'Another teacher takes it' : 'Cancel this class';
  return (
    <Sheet open onClose={onClose} title={title}>
      <Text variant="small">
        {s.courseCode} · {zoned(s.scheduledStart, tz).dow} {zoned(s.scheduledStart, tz).hm}. Its students are notified as soon as you confirm.
      </Text>
      {mode === 'reschedule' ? (
        <>
          <Field label="New date">
            <DateField value={date} onChange={setDate} />
          </Field>
          <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
            <Field label="Starts">
              <TimeField
                label="Start"
                value={start}
                onChange={(v) => {
                  const dur = toMinutes(end) - toMinutes(start);
                  setStart(v);
                  setEnd(fromMinutes(Math.min(toMinutes(v) + Math.max(dur, 30), 23 * 60 + 55)));
                }}
              />
            </Field>
            <Field label="Ends">
              <TimeField label="End" value={end} onChange={setEnd} />
            </Field>
          </View>
          <Field label="Room">
            <Select title="Room" value={roomId} onChange={setRoomId} allowNone="No room" options={(rooms.data ?? []).filter((r) => r.active).map((r) => ({ value: r.id, label: r.name }))} />
          </Field>
        </>
      ) : mode === 'substitute' ? (
        <View style={{ marginTop: 12 }}>
          <TeacherPicker
            date={ymdIn(startMs, tz)}
            start={zoned(s.scheduledStart, tz).hm}
            end={zoned(s.scheduledEnd, tz).hm}
            value={teacherId}
            onChange={setTeacherId}
            excludeSessionId={s.id}
            courseTeacherId={s.teacher?.id ?? null}
          />
        </View>
      ) : (
        <Field label="Reason (students see this)">
          <Input value={reason} onChangeText={setReason} placeholder="e.g. Faculty meeting — make-up class on Friday" maxLength={200} autoFocus />
        </Field>
      )}

      {result && !result.published ? (
        <Card tone={onlyWarnings ? 'amber' : 'red'} style={{ marginTop: 14, gap: 8 }}>
          <Text variant="bodyStrong">{onlyWarnings ? 'Check before confirming' : 'This change can’t be made'}</Text>
          <ConflictList conflicts={result.conflicts} errors={result.errors} />
        </Card>
      ) : null}
      {result?.published ? (
        <View style={{ marginTop: 14 }}>
          <Notice tone="green" message={`Done · ${result.notified} ${result.notified === 1 ? 'person' : 'people'} notified.`} />
        </View>
      ) : null}
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      {!result?.published ? (
        onlyWarnings ? (
          <Button title="Confirm anyway" onPress={() => void submit(true)} loading={busy} style={{ marginTop: 14 }} />
        ) : (
          <Button title={mode === 'cancel' ? 'Cancel class & notify' : 'Confirm & notify'} kind={mode === 'cancel' ? 'danger' : 'primary'} onPress={() => void submit(false)} loading={busy} disabled={invalid} style={{ marginTop: 16 }} />
        )
      ) : null}
      {mode === 'substitute' && s.substitute ? <Badge label={`Now: ${s.substitute.name}`} tone="violet" dot={false} /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  teacher: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised },
  teacherOn: { borderColor: 'rgba(34,211,238,0.55)', backgroundColor: 'rgba(34,211,238,0.08)' },
});
