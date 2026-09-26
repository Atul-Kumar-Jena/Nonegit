import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, Inbox, MessageSquareText, Send, UserRound } from 'lucide-react-native';
import { STUDENT_TOPIC_LABELS, type ChangeRequest, type CoverResponse, type PlannerConflict, type OpError, type StaffSession } from '@attendly/protocol';
import { Badge, Button, Card, Input, Notice, Text } from '@kit/components/ui';
import { timeAgo, zoned, dayLabel } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, type Tone } from '@kit/theme';
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
  return `${dayLabel(r.session.start, tz)} ${zoned(r.session.start, tz).hm}–${zoned(r.session.end, tz).hm}`;
}

/**
 * One request. Incoming + pending: reply and Accept / Decline right here.
 * Outgoing + pending: Withdraw. Everything else: the outcome and any reply.
 */
export function RequestCard({ r, incoming, tz }: { r: ChangeRequest; incoming: boolean; tz?: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'accept' | 'decline' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ conflicts: PlannerConflict[]; errors: OpError[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const status = STATUS[r.status];
  const cover = r.kind === 'cover';
  const title = cover ? (incoming ? `${r.from.name} asks you to take ${r.session.courseCode}` : `You asked ${r.to.name} to take ${r.session.courseCode}`) : `${r.from.name}${r.from.rollNo ? ` (${r.from.rollNo})` : ''}: ${STUDENT_TOPIC_LABELS[r.topic as keyof typeof STUDENT_TOPIC_LABELS] ?? 'Question'}`;
  const onlyWarnings = !!check && check.errors.length === 0 && check.conflicts.length > 0 && check.conflicts.every((c) => c.severity === 'warning');

  async function run(kind: 'accept' | 'decline' | 'cancel', acceptWarnings = false) {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'accept') {
        const res = await staffApi.acceptRequest(api, r.id, reply.trim() || undefined, acceptWarnings);
        if (res.request.status !== 'accepted') {
          setCheck({ conflicts: res.conflicts, errors: res.errors });
          return;
        }
        setDone(cover ? `Done — ${r.session.courseCode} is yours. ${Math.max(0, res.notified - 1)} students notified.` : 'Reply sent.');
      } else if (kind === 'decline') {
        await staffApi.declineRequest(api, r.id, reply.trim() || undefined);
        setDone('Reply sent.');
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
    <Card tone={incoming && r.status === 'pending' ? (cover ? 'violet' : 'cyan') : undefined} style={{ gap: 8 }}>
      <View style={styles.row}>
        {cover ? <UserRound color={colors.violet} size={16} /> : <MessageSquareText color={colors.cyan} size={16} />}
        <Text variant="bodyStrong" style={{ flex: 1 }}>
          {title}
        </Text>
        <Badge label={status.label} tone={status.tone} dot={false} />
      </View>
      <View style={styles.row}>
        <CalendarClock color={colors.textDim} size={13} />
        <Text variant="small" style={{ flex: 1 }}>
          {r.session.courseCode} · {r.session.courseTitle} · {whenLabel(r, tz)}
          {r.session.room ? ` · ${r.session.room}` : ''}
        </Text>
      </View>
      {r.noteToTeacher ? (
        <Text variant="body" style={styles.quote}>
          “{r.noteToTeacher}”
        </Text>
      ) : null}
      {cover && r.noteToStudents ? <Text variant="small">Students will see: “{r.noteToStudents}”</Text> : null}
      {r.reply ? (
        <Text variant="small" color={colors.text}>
          Reply from {incoming ? 'you' : r.to.name}: “{r.reply}”
        </Text>
      ) : null}
      <Text variant="monoSmall">
        {incoming ? `Asked ${timeAgo(r.createdAt)}` : `Sent ${timeAgo(r.createdAt)} to ${r.to.name}`}
        {r.decidedAt ? ` · answered ${timeAgo(r.decidedAt)}` : ''}
      </Text>

      {done ? <Notice tone="green" message={done} /> : null}
      {error ? <Notice tone="red" message={error} /> : null}
      {check ? (
        <Card tone={onlyWarnings ? 'amber' : 'red'} style={{ gap: 8 }}>
          <Text variant="bodyStrong">{onlyWarnings ? 'Check before accepting' : 'You can’t take it right now'}</Text>
          <ConflictList conflicts={check.conflicts} errors={check.errors} />
        </Card>
      ) : null}

      {r.status === 'pending' && !done ? (
        incoming ? (
          <>
            <Input value={reply} onChangeText={setReply} placeholder={cover ? 'Reply (optional), e.g. “Sure, I’ll cover unit 3”' : 'Reply to the student (optional)'} maxLength={300} />
            <View style={styles.row}>
              {onlyWarnings ? (
                <Button title="Accept anyway" onPress={() => void run('accept', true)} loading={busy === 'accept'} style={{ flex: 1 }} />
              ) : (
                <Button title={cover ? 'Accept' : 'Yes'} onPress={() => void run('accept')} loading={busy === 'accept'} disabled={!!busy} style={{ flex: 1 }} />
              )}
              <Button title={cover ? 'Decline' : 'No'} kind="secondary" onPress={() => void run('decline')} loading={busy === 'decline'} disabled={!!busy} style={{ flex: 1 }} />
            </View>
            {!cover ? (
              <Button title="Open the class to adjust it" kind="ghost" compact onPress={() => router.push(`/session/${r.session.id}`)} icon={<ArrowRight color={colors.text} size={14} />} />
            ) : null}
          </>
        ) : (
          <Button title="Withdraw" kind="ghost" compact onPress={() => void run('cancel')} loading={busy === 'cancel'} />
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
          <Field label="Note to the teacher (optional)" hint="Shown with the request — e.g. why, and what to cover.">
            <Input value={toTeacher} onChangeText={setToTeacher} placeholder="e.g. I’m at a conference — please cover unit 3" maxLength={300} multiline />
          </Field>
        ) : null}
        {teacherId ? (
          <Field label="Note to the students (optional)" hint={self ? 'Sent with the change.' : 'Sent to the students only once the teacher accepts.'}>
            <Input value={toStudents} onChangeText={setToStudents} placeholder="e.g. Bring your lab records" maxLength={300} multiline />
          </Field>
        ) : null}

        {teacherId ? (
          <Card style={{ marginTop: 14, gap: 4 }}>
            <Text variant="small">
              {self
                ? 'You take this class now. Its students are notified straight away.'
                : 'Nothing changes yet: the teacher gets a notification (with sound) and accepts or declines. When they accept, the class becomes theirs and the students are notified with your note.'}
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
            <Notice tone="green" message={result.status === 'applied' ? `Done · ${result.notified} people notified.` : 'Request sent. You’ll be notified when they answer.'} />
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
              title={self ? 'Take this class' : 'Send request'}
              onPress={() => void send(false)}
              loading={busy}
              disabled={!teacherId}
              icon={<Send color="#03141c" size={16} />}
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
  quote: { borderLeftWidth: 3, borderLeftColor: colors.violet, paddingLeft: 10, color: colors.text },
});
