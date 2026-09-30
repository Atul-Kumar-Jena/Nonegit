import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, Inbox, MessageSquareText, Send, UserRound } from 'lucide-react-native';
import { STUDENT_TOPIC_LABELS, type ChangeRequest, type CoverResponse, type PlannerConflict, type OpError, type StaffSession } from '@attendly/protocol';
import { Avatar, Badge, Button, Card, Input, Notice, Segmented, Text } from '@kit/components/ui';
import { timeAgo, zoned, dayLabel, clock, initials } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts, radius, type Tone } from '@kit/theme';
import { staffApi } from '@/api';
import { ymdIn } from '@/time';
import { ConflictList, TeacherPicker } from './Adjust';
import { Field, Sheet } from './forms';

const STATUS: Record<ChangeRequest['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'amber' },
  accepted: { label: 'Accepted', tone: 'green' },
  declined: { label: 'Declined', tone: 'red' },
  cancelled: { label: 'Withdrawn', tone: 'muted' },
  expired: { label: 'Expired', tone: 'muted' },
};

export function whenLabel(r: ChangeRequest, tz?: string): string {
  return `${dayLabel(r.session.start, tz)} ${clock(r.session.start, tz)}–${clock(r.session.end, tz)}`;
}

const QUICK_COVER = ['Sure, I’ll take it', 'Yes — share the notes please', 'Sorry, I’m busy then'];
const QUICK_STUDENT = ['Yes, done', 'I’ll check and tell you', 'Not possible this week'];

/**
 * One request. Incoming + pending: quick replies, then Accept / Decline right here.
 * Outgoing + pending: assign it outright, or withdraw. Everything else: the outcome and any reply.
 */
export function RequestCard({ r, incoming, tz }: { r: ChangeRequest; incoming: boolean; tz?: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'accept' | 'decline' | 'cancel' | 'assign' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ conflicts: PlannerConflict[]; errors: OpError[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const status = STATUS[r.status];
  const cover = r.kind === 'cover';
  const other = incoming ? r.from : r.to;
  const title = cover
    ? incoming
      ? `Can you take ${r.session.courseCode}?`
      : `Asked to take ${r.session.courseCode}`
    : (STUDENT_TOPIC_LABELS[r.topic as keyof typeof STUDENT_TOPIC_LABELS] ?? 'A question');
  const onlyWarnings = !!check && check.errors.length === 0 && check.conflicts.length > 0 && check.conflicts.every((c) => c.severity === 'warning');
  const pending = r.status === 'pending' && !done;

  async function run(kind: 'accept' | 'decline' | 'cancel' | 'assign', acceptWarnings = false) {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'accept') {
        const res = await staffApi.acceptRequest(api, r.id, reply.trim() || undefined, acceptWarnings);
        if (res.request.status !== 'accepted') {
          setCheck({ conflicts: res.conflicts, errors: res.errors });
          return;
        }
        setDone(cover ? `Done — ${r.session.courseCode} is yours. Its students were notified.` : 'Reply sent.');
      } else if (kind === 'decline') {
        await staffApi.declineRequest(api, r.id, reply.trim() || undefined);
        setDone('Reply sent.');
      } else if (kind === 'assign') {
        const res = await staffApi.coverRequest(api, { sessionId: r.session.id, teacherId: r.to.id, noteToStudents: r.noteToStudents ?? undefined, acceptWarnings: true, mode: 'assign' });
        if (res.status === 'refused') {
          setCheck({ conflicts: res.conflicts, errors: res.errors });
          return;
        }
        setDone(`Assigned — ${r.to.name} takes it; ${res.notified} ${res.notified === 1 ? 'person' : 'people'} notified.`);
      } else {
        await staffApi.cancelRequest(api, r.id);
        setDone('Withdrawn.');
      }
      void qc.invalidateQueries({ queryKey: ['staff'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      void qc.invalidateQueries({ queryKey: ['staff', 'change-requests'] });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card tone={incoming && pending ? 'violet' : undefined} style={{ gap: 12 }}>
      <View style={styles.row}>
        <Avatar text={initials(other.name) || '?'} size={40} />
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong" numberOfLines={2}>
            {title}
          </Text>
          <Text variant="small" numberOfLines={1}>
            {incoming ? `From ${r.from.name}${r.from.rollNo ? ` · ${r.from.rollNo}` : ''}` : `To ${r.to.name}`} · {timeAgo(r.createdAt)}
          </Text>
        </View>
        <Badge label={done && r.status === 'pending' ? 'Done' : status.label} tone={done && r.status === 'pending' ? 'green' : status.tone} dot={false} />
      </View>

      <Pressable onPress={() => router.push(`/session/${r.session.id}`)} accessibilityRole="button" accessibilityLabel={`Open ${r.session.courseCode}`} style={styles.classBox}>
        {cover ? <UserRound color={colors.textMuted} size={15} /> : <MessageSquareText color={colors.textMuted} size={15} />}
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong" numberOfLines={1} style={{ fontSize: 14 }}>
            {r.session.courseCode} · {r.session.courseTitle}
          </Text>
          <Text variant="small" numberOfLines={1}>
            {whenLabel(r, tz)}
            {r.session.room ? ` · ${r.session.room}` : ''}
          </Text>
        </View>
        <CalendarClock color={colors.textDim} size={15} />
      </Pressable>

      {r.noteToTeacher ? <Text style={styles.quote}>“{r.noteToTeacher}”</Text> : null}
      {cover && r.noteToStudents ? <Text variant="small">{`For the students: “${r.noteToStudents}”`}</Text> : null}
      {r.reply ? (
        <Text variant="small" color={colors.text}>
          {`${incoming ? 'You replied' : `${r.to.name} replied`}: “${r.reply}”`}
          {r.decidedAt ? ` · ${timeAgo(r.decidedAt)}` : ''}
        </Text>
      ) : null}

      {done ? <Notice tone="green" message={done} /> : null}
      {error ? <Notice tone="red" message={error} /> : null}
      {check ? (
        <Card tone={onlyWarnings ? 'amber' : 'red'} style={{ gap: 8 }}>
          <Text variant="bodyStrong">{onlyWarnings ? 'Check before going ahead' : 'Can’t do that right now'}</Text>
          <ConflictList conflicts={check.conflicts} errors={check.errors} />
        </Card>
      ) : null}

      {pending ? (
        incoming ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {(cover ? QUICK_COVER : QUICK_STUDENT).map((q) => (
                <Pressable key={q} onPress={() => setReply(q)} accessibilityRole="button" style={[styles.quick, reply === q && styles.quickOn]}>
                  <Text style={[styles.quickText, reply === q && { color: colors.ink }]}>{q}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Input value={reply} onChangeText={setReply} placeholder={cover ? 'Or write a reply (optional)' : 'Reply to the student (optional)'} maxLength={300} />
            <View style={styles.row}>
              <Button title={cover ? 'Decline' : 'No'} kind="secondary" onPress={() => void run('decline')} loading={busy === 'decline'} disabled={!!busy} style={{ flex: 1 }} />
              {onlyWarnings ? (
                <Button title="Accept anyway" onPress={() => void run('accept', true)} loading={busy === 'accept'} style={{ flex: 1 }} />
              ) : (
                <Button title={cover ? 'Accept' : 'Yes'} onPress={() => void run('accept')} loading={busy === 'accept'} disabled={!!busy} style={{ flex: 1 }} />
              )}
            </View>
          </>
        ) : cover ? (
          <View style={styles.row}>
            <Button title="Withdraw" kind="secondary" compact onPress={() => void run('cancel')} loading={busy === 'cancel'} disabled={!!busy} style={{ flex: 1 }} />
            <Button title="Assign now" compact onPress={() => void run('assign')} loading={busy === 'assign'} disabled={!!busy} style={{ flex: 1 }} />
          </View>
        ) : (
          <Button title="Withdraw" kind="secondary" compact onPress={() => void run('cancel')} loading={busy === 'cancel'} />
        )
      ) : null}
    </Card>
  );
}

/** A short banner for Today: requests waiting for my answer. */
export function RequestsBanner({ requests, tz }: { requests: ChangeRequest[]; tz?: string }) {
  const waiting = requests.filter((r) => r.status === 'pending');
  if (!waiting.length) return null;
  return (
    <View style={{ marginTop: 16, gap: 10 }}>
      <View style={styles.row}>
        <Inbox color={colors.violet} size={16} />
        <Text variant="label" style={{ flex: 1 }}>
          {waiting.length === 1 ? '1 request waiting for you' : `${waiting.length} requests waiting for you`}
        </Text>
        {waiting.length > 1 ? (
          <Button title="See all" kind="ghost" compact onPress={() => router.push('/inbox')} />
        ) : null}
      </View>
      <RequestCard r={waiting[0]!} incoming tz={tz} />
    </View>
  );
}

/**
 * Hand a class to another teacher (or take it yourself), with a note for them and one for the
 * students. Nothing changes until the teacher accepts.
 */
export function CoverSheet({
  session: s,
  teacherId: initialTeacher,
  tz,
  meId,
  onClose,
}: {
  session: StaffSession;
  teacherId: string | null;
  tz?: string;
  meId?: string;
  onClose: (sent?: CoverResponse) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [teacherId, setTeacherId] = useState<string | null>(initialTeacher);
  const [picking, setPicking] = useState(!initialTeacher);
  const [toTeacher, setToTeacher] = useState('');
  const [toStudents, setToStudents] = useState('');
  const [mode, setMode] = useState<'assign' | 'ask'>('assign');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CoverResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const date = ymdIn(Date.parse(s.scheduledStart), tz);
  const start = zoned(s.scheduledStart, tz).hm;
  const end = zoned(s.scheduledEnd, tz).hm;
  const self = teacherId !== null && teacherId === meId;
  const onlyWarnings = !!result && result.status === 'refused' && result.errors.length === 0 && result.conflicts.length > 0 && result.conflicts.every((c) => c.severity === 'warning');

  async function send(acceptWarnings: boolean) {
    if (!teacherId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await staffApi.coverRequest(api, {
        sessionId: s.id,
        teacherId,
        noteToTeacher: toTeacher.trim() || undefined,
        noteToStudents: toStudents.trim() || undefined,
        acceptWarnings,
        mode,
      });
      setResult(r);
      if (r.status !== 'refused') {
        void qc.invalidateQueries({ queryKey: ['staff'] });
        setTimeout(() => onClose(r), 1500);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t send the request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={() => onClose()} title="Cover this class">
      <ScrollView style={{ maxHeight: 560 }} keyboardShouldPersistTaps="handled">
        <Text variant="bodyStrong">
          {s.courseCode} · {s.courseTitle}
        </Text>
        <Text variant="small">
          {dayLabel(s.scheduledStart, tz)} {start}–{end}
          {s.roomLabel ? ` · ${s.roomLabel}` : ''} · now {s.substitute?.name ?? s.teacher?.name ?? 'no teacher'}
        </Text>

        <Field label="Who takes it">
          {picking || !teacherId ? (
            <TeacherPicker
              date={date}
              start={start}
              end={end}
              value={teacherId}
              onChange={(id) => {
                setTeacherId(id);
                setResult(null);
                if (id) setPicking(false);
              }}
              excludeSessionId={s.id}
              courseTeacherId={null}
            />
          ) : (
            <TeacherPicker date={date} start={start} end={end} value={teacherId} onChange={() => setPicking(true)} excludeSessionId={s.id} courseTeacherId={null} onlyId={teacherId} />
          )}
        </Field>

        {teacherId && !self ? (
          <View style={{ marginTop: 16 }}>
            <Segmented
              value={mode}
              options={[
                { value: 'assign', label: 'Assign now' },
                { value: 'ask', label: 'Ask first' },
              ]}
              onChange={setMode}
            />
          </View>
        ) : null}

        {teacherId && !self ? (
          <Field label="Note to the teacher (optional)" hint="Shown with the request — e.g. why, and what to cover.">
            <Input value={toTeacher} onChangeText={setToTeacher} placeholder="e.g. I’m at a conference — please cover unit 3" maxLength={300} multiline />
          </Field>
        ) : null}
        {teacherId ? (
          <Field label="Note to the students (optional)" hint={self || mode === 'assign' ? 'Sent to every student of this class right away.' : 'Sent to the students when the teacher accepts.'}>
            <Input value={toStudents} onChangeText={setToStudents} placeholder="e.g. Bring your lab records" maxLength={300} multiline />
          </Field>
        ) : null}

        {teacherId ? (
          <Card style={{ marginTop: 14, gap: 4 }}>
            <Text variant="small">
              {self
                ? 'You take this class now. Its students are notified straight away.'
                : mode === 'assign'
                  ? 'The class becomes theirs now. The teacher and every student are notified at once, with your notes.'
                  : 'Nothing changes yet: the teacher gets a notification and accepts or declines. When they accept, the class becomes theirs and the students are notified with your note.'}
            </Text>
          </Card>
        ) : null}

        {result?.status === 'refused' ? (
          <Card tone={onlyWarnings ? 'amber' : 'red'} style={{ marginTop: 14, gap: 8 }}>
            <Text variant="bodyStrong">{onlyWarnings ? 'Check before sending' : 'This teacher can’t take it'}</Text>
            <ConflictList conflicts={result.conflicts} errors={result.errors} />
          </Card>
        ) : null}
        {result && result.status !== 'refused' ? (
          <View style={{ marginTop: 14 }}>
            <Notice tone="green" message={result.status === 'applied' ? `Done · ${result.notified} ${result.notified === 1 ? 'person' : 'people'} notified.` : 'Request sent. You’ll be notified when they answer.'} />
          </View>
        ) : null}
        {error ? (
          <View style={{ marginTop: 12 }}>
            <Notice tone="red" message={error} />
          </View>
        ) : null}
        {!result || result.status === 'refused' ? (
          onlyWarnings ? (
            <Button title="Send anyway" onPress={() => void send(true)} loading={busy} style={{ marginTop: 14 }} />
          ) : (
            <Button
              title={self ? 'Take this class' : mode === 'assign' ? 'Assign & notify' : 'Send request'}
              onPress={() => void send(false)}
              loading={busy}
              disabled={!teacherId}
              icon={<Send color="#0a0a0a" size={16} />}
              style={{ marginTop: 16 }}
            />
          )
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.textMuted, paddingLeft: 12, color: colors.text, fontFamily: fonts.medium, fontSize: 14.5, lineHeight: 21 },
  classBox: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radius.md, backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: colors.border },
  quick: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.borderHi, backgroundColor: colors.cardHi },
  quickOn: { backgroundColor: colors.text, borderColor: colors.text },
  quickText: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
});
