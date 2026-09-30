import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { UserPlus } from 'lucide-react-native';
import type { ChangeRequest } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { ErrorState, Loading, Segmented, Text } from '@kit/components/ui';
import { colors, fonts } from '@kit/theme';
import { Chips, Empty, Header } from '@/components/forms';
import { RequestCard } from '@/components/Requests';
import { useChangeRequests, useCan, useOverview } from '@/queries';

type Tab = 'answer' | 'sent' | 'history';

/** Requests: what needs my answer, what I'm waiting on, and everything already decided. */
export default function InboxScreen() {
  const q = useChangeRequests();
  const tz = useOverview().data?.timezone;
  const planner = useCan('planner');
  const incoming = q.data?.incoming ?? [];
  const outgoing = q.data?.outgoing ?? [];
  const toAnswer = incoming.filter((r) => r.status === 'pending');
  const waiting = outgoing.filter((r) => r.status === 'pending');
  const [tab, setTab] = useState<Tab>(() => (toAnswer.length || !planner ? 'answer' : 'sent'));
  const [kind, setKind] = useState<'all' | 'cover' | 'student'>('all');

  const history = useMemo(
    () =>
      [...incoming.map((r) => ({ r, incoming: true })), ...outgoing.map((r) => ({ r, incoming: false }))]
        .filter(({ r }) => r.status !== 'pending')
        .sort((a, b) => (b.r.decidedAt ?? b.r.createdAt).localeCompare(a.r.decidedAt ?? a.r.createdAt)),
    [incoming, outgoing],
  );
  const shown: { r: ChangeRequest; incoming: boolean }[] = (tab === 'answer' ? toAnswer.map((r) => ({ r, incoming: true })) : tab === 'sent' ? waiting.map((r) => ({ r, incoming: false })) : history).filter(
    ({ r }) => kind === 'all' || (kind === 'cover' ? r.kind === 'cover' : r.kind !== 'cover'),
  );
  const kinds = new Set([...incoming, ...outgoing].map((r) => (r.kind === 'cover' ? 'cover' : 'student')));

  return (
    <Screen
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
      fab={planner ? { label: 'Cover a class', icon: <UserPlus color={colors.ink} size={17} />, onPress: () => router.push('/cover') } : null}
    >
      <Header info="inbox" title="Requests" subtitle="Covers · students’ questions" />
      {q.isPending ? (
        <Loading />
      ) : q.error && !q.data ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <View style={styles.stats}>
            <Pressable onPress={() => setTab('answer')} accessibilityRole="button" style={[styles.stat, tab === 'answer' && styles.statOn]}>
              <Text style={[styles.statN, toAnswer.length ? { color: colors.amber } : null]}>{toAnswer.length}</Text>
              <Text variant="small">need your answer</Text>
            </Pressable>
            <Pressable onPress={() => setTab('sent')} accessibilityRole="button" style={[styles.stat, tab === 'sent' && styles.statOn]}>
              <Text style={styles.statN}>{waiting.length}</Text>
              <Text variant="small">waiting on others</Text>
            </Pressable>
          </View>
          <View style={{ marginTop: 14 }}>
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: 'answer', label: toAnswer.length ? `To answer · ${toAnswer.length}` : 'To answer' },
                { value: 'sent', label: waiting.length ? `Sent · ${waiting.length}` : 'Sent' },
                { value: 'history', label: 'History' },
              ]}
            />
          </View>
          {kinds.size > 1 ? (
            <View style={{ marginTop: 12 }}>
              <Chips
                value={kind}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'cover', label: 'Class covers' },
                  { value: 'student', label: 'From students' },
                ]}
                onChange={setKind}
              />
            </View>
          ) : null}
          <View style={{ gap: 12, marginTop: 14 }}>
            {shown.length === 0 ? (
              <Empty
                title={tab === 'answer' ? 'You’re all caught up' : tab === 'sent' ? 'Nothing waiting' : 'No history yet'}
                message={
                  tab === 'answer'
                    ? 'When you’re asked to take a class, or a student asks about one, it shows up here with a notification.'
                    : tab === 'sent'
                      ? planner
                        ? 'Requests you send wait here until they’re answered. Tap “Cover a class” to send one.'
                        : 'Only admins (and professors with “Planner & cover”) hand classes out.'
                      : 'Answered, withdrawn and expired requests stay here for 30 days.'
                }
              />
            ) : (
              shown.map(({ r, incoming: inc }) => <RequestCard key={`${inc ? 'in' : 'out'}:${r.id}`} r={r} incoming={inc} tz={tz} />)
            )}
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: 'row', gap: 10, marginTop: 6 },
  stat: { flex: 1, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, gap: 2 },
  statOn: { borderColor: colors.textMuted },
  statN: { fontFamily: fonts.display, fontSize: 26, color: colors.text },
});
