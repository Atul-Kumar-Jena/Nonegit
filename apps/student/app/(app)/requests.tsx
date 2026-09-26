import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MessageSquareText } from 'lucide-react-native';
import { ChangeRequest, STUDENT_TOPIC_LABELS } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, IconButton, Loading, Notice, Text } from '@kit/components/ui';
import { dayLabel, timeAgo, zoned, clock } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, type Tone } from '@kit/theme';
import { qk, useMyRequests, useTimetable } from '@/state/queries';

const STATUS: Record<ChangeRequest['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Waiting for reply', tone: 'amber' },
  accepted: { label: 'Yes', tone: 'green' },
  declined: { label: 'No', tone: 'red' },
  cancelled: { label: 'Withdrawn', tone: 'muted' },
  expired: { label: 'Expired', tone: 'muted' },
};

/** My questions to teachers ("please move this class"…) and their replies. */
export default function MyRequests() {
  const q = useMyRequests();
  const tz = useTimetable().data?.timezone;
  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <IconButton label="Back" onPress={back}>
        <ArrowLeft color={colors.text} size={18} />
      </IconButton>
      <Text variant="heading" style={{ flex: 1 }}>
        My requests
      </Text>
    </View>
  );
  if (q.isPending)
    return (
      <Screen scroll={false}>
        {header}
        <Loading />
      </Screen>
    );
  if (q.error)
    return (
      <Screen>
        {header}
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      </Screen>
    );
  const list = q.data.outgoing;
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      {header}
      {list.length === 0 ? (
        <Card style={{ alignItems: 'center', gap: 8, paddingVertical: 28 }}>
          <MessageSquareText color={colors.textDim} size={26} />
          <Text variant="bodyStrong">No requests yet</Text>
          <Text variant="small" style={{ textAlign: 'center' }}>
            To ask a teacher to move a class, hold an extra one, or anything else: open Timetable and tap “Ask” on the class.
          </Text>
          <Button title="Open timetable" kind="secondary" compact onPress={() => router.push('/timetable')} />
        </Card>
      ) : (
        <View style={{ gap: 12 }}>
          {list.map((r) => (
            <RequestItem key={r.id} r={r} tz={tz} />
          ))}
        </View>
      )}
    </Screen>
  );
}

function RequestItem({ r, tz }: { r: ChangeRequest; tz?: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = STATUS[r.status];
  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await api.authed('POST', `/v1/me/requests/${encodeURIComponent(r.id)}/cancel`, ChangeRequest, {});
      void qc.invalidateQueries({ queryKey: qk.requests });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t withdraw it.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card tone={r.status === 'accepted' ? 'green' : undefined} style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text variant="bodyStrong" style={{ flex: 1 }}>
          {STUDENT_TOPIC_LABELS[r.topic as keyof typeof STUDENT_TOPIC_LABELS] ?? 'Request'}
        </Text>
        <Badge label={st.label} tone={st.tone} dot={false} />
      </View>
      <Text variant="small">
        {r.session.courseCode} · {dayLabel(r.session.start, tz)} {clock(r.session.start, tz)} · to {r.to.name}
      </Text>
      {r.noteToTeacher ? <Text variant="body">“{r.noteToTeacher}”</Text> : null}
      {r.reply ? (
        <Text variant="body" color={colors.text}>
          {r.to.name}: “{r.reply}”
        </Text>
      ) : null}
      <Text variant="monoSmall">
        Sent {timeAgo(r.createdAt)}
        {r.decidedAt ? ` · answered ${timeAgo(r.decidedAt)}` : ''}
      </Text>
      {error ? <Notice tone="red" message={error} /> : null}
      {r.status === 'pending' ? <Button title="Withdraw" kind="ghost" compact onPress={() => void withdraw()} loading={busy} /> : null}
    </Card>
  );
}
