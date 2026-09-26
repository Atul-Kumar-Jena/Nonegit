import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { UserPlus } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Button, ErrorState, Loading, Segmented, Text } from '@kit/components/ui';
import { colors } from '@kit/theme';
import { Empty, Header } from '@/components/forms';
import { RequestCard } from '@/components/Requests';
import { useChangeRequests, useIsAdmin, useOverview } from '@/queries';

/** Requests: teachers asking me to cover, students' questions, and what I sent. */
export default function InboxScreen() {
  const q = useChangeRequests();
  const tz = useOverview().data?.timezone;
  const admin = useIsAdmin();
  const [tab, setTab] = useState<'in' | 'out'>(admin ? 'out' : 'in');
  if (q.isPending)
    return (
      <Screen scroll={false}>
        <Header info="inbox" title="Requests" />
        <Loading />
      </Screen>
    );
  if (q.error)
    return (
      <Screen>
        <Header info="inbox" title="Requests" />
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      </Screen>
    );
  const incoming = q.data.incoming;
  const outgoing = q.data.outgoing;
  const waiting = incoming.filter((r) => r.status === 'pending').length;
  const list = tab === 'in' ? incoming : outgoing;
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header info="inbox" title="Requests" subtitle="Cover classes · students’ questions" right={admin ? <Button title="Cover" kind="ghost" compact onPress={() => router.push('/cover')} icon={<UserPlus color={colors.text} size={14} />} /> : undefined} />
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'in', label: waiting ? `For me · ${waiting}` : 'For me' },
          { value: 'out', label: 'Sent by me' },
        ]}
      />
      <View style={{ gap: 12, marginTop: 14 }}>
        {list.length === 0 ? (
          <Empty
            title={tab === 'in' ? 'Nothing for you' : 'You haven’t asked anyone'}
            message={
              tab === 'in'
                ? 'When your admin asks you to take a class, or a student asks about one, it shows up here (with a notification).'
                : admin
                  ? 'Use “Cover a class” to hand a class to a free teacher.'
                  : 'Teachers answer requests; only admins hand classes out.'
            }
          />
        ) : (
          list.map((r) => <RequestCard key={r.id} r={r} incoming={tab === 'in'} tz={tz} />)
        )}
      </View>
      <Text variant="small" style={{ marginTop: 16 }}>
        Answered requests stay here for 30 days.
      </Text>
    </Screen>
  );
}
