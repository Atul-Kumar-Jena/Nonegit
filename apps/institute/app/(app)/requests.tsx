import { useState } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Smartphone } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Avatar, Badge, Button, Card, ErrorState, Loading, Notice, Segmented, Text } from '@kit/components/ui';
import { initials, timeAgo } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { Empty, Header, confirmAction } from '@/components/forms';
import { useDeviceRequests, useMe } from '@/queries';

/** Phone switches and resets waiting for approval. One person, one phone — nobody can approve their own. */
export default function Requests() {
  const api = useApi();
  const qc = useQueryClient();
  const q = useDeviceRequests();
  const me = useMe().data;
  const myName = me?.user.fullName;
  const [show, setShow] = useState<'mine' | 'all'>('mine');
  // Mentors handle their batches' students; admins are the backup for everyone without a mentor.
  const needsMe = (r: { mentors: string[] }) => r.mentors.length === 0 || (!!myName && r.mentors.includes(myName));
  const all = q.data ?? [];
  const list = show === 'mine' ? all.filter(needsMe) : all;
  const handledByMentors = all.length - all.filter(needsMe).length;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: 'approve' | 'deny') {
    setBusy(id + decision);
    setError(null);
    try {
      await staffApi.decide(api, id, decision);
      void qc.invalidateQueries({ queryKey: ['staff'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the decision.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header info="phoneRequests" title="Phone requests" />
      <Text variant="small">
        Each account works on one phone. Approve only if you’re sure the request is genuine — e.g. the person told you they changed phones.
      </Text>
      {handledByMentors > 0 || show === 'all' ? (
        <View style={{ marginTop: 12 }}>
          <Segmented
            value={show}
            options={[
              { value: 'mine', label: `Needs you (${all.length - handledByMentors})` },
              { value: 'all', label: `All (${all.length})` },
            ]}
            onChange={setShow}
          />
          <Text variant="small" style={{ marginTop: 6 }}>
            {`${handledByMentors} ${handledByMentors === 1 ? 'request is' : 'requests are'} with the students’ batch mentors. You can still decide any of them.`}
          </Text>
        </View>
      ) : null}
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      <View style={{ gap: 10, marginTop: 14 }}>
        {q.isPending ? (
          <Loading />
        ) : q.isError && !q.data ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : list.length === 0 ? (
          <Empty title={all.length ? 'Nothing needs you — mentors are on it' : 'No pending requests'} />
        ) : (
          list.map((r) => (
            <Card key={r.id} style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Avatar text={initials(r.user.fullName) || '?'} size={40} />
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {r.user.fullName}
                  </Text>
                  <Text variant="small" numberOfLines={1}>
                    {[r.user.rollNo, r.user.role, timeAgo(r.createdAt)].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Badge label={r.kind === 'rebind' ? 'New phone' : 'Reset'} tone={r.kind === 'rebind' ? 'violet' : 'amber'} dot={false} />
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Smartphone color={colors.textDim} size={14} />
                <Text variant="small" style={{ flexShrink: 1 }}>
                  {r.from ? r.from.model : 'no phone'}
                </Text>
                <ArrowRight color={colors.textDim} size={14} />
                <Text variant="small" color={colors.text} style={{ flexShrink: 1 }}>
                  {r.to ? `${r.to.model} (${r.to.platform})` : 'unbound — binds at next sign-in'}
                </Text>
              </View>
              <Text variant="body" color={colors.text}>
                “{r.reason}”
              </Text>
              {r.mentors.length ? (
                <Text variant="small">{`Mentor: ${r.mentors.join(', ')}${myName && r.mentors.includes(myName) ? ' (you)' : ' handles this'}`}</Text>
              ) : r.user.role === 'student' ? (
                <Text variant="small">No batch mentor — admins decide.</Text>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Button title="Deny" kind="secondary" compact loading={busy === r.id + 'deny'} onPress={() => void decide(r.id, 'deny')} style={{ flex: 1 }} />
                <Button
                  title="Approve"
                  compact
                  loading={busy === r.id + 'approve'}
                  onPress={() =>
                    confirmAction('Approve?', `${r.user.fullName}’s old phone stops working immediately${r.kind === 'rebind' ? ' and the new one is bound' : ''}.`, 'Approve', () => void decide(r.id, 'approve'))
                  }
                  style={{ flex: 1 }}
                />
              </View>
            </Card>
          ))
        )}
      </View>
    </Screen>
  );
}
