import { View } from 'react-native';
import { router } from 'expo-router';
import { Plus } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Button, Loading, SectionLabel, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { Empty, Header } from '@/components/forms';
import { SessionCard } from '@/components/SessionCard';
import { useLocalSessions, withLocal } from '@/local-sessions';
import { useOfflinePack, useOverview } from '@/queries';
import { canStartNow, ymdIn } from '@/time';

/** "Take attendance now": the classes that are running or can be started right now. */
export default function Attend() {
  const api = useApi();
  const q = useOverview();
  const pack = useOfflinePack();
  const local = useLocalSessions();
  const tz = q.data?.timezone ?? pack.data?.timezone;
  const now = api.serverNow();
  const today = ymdIn(now, tz);
  const all = (q.data?.today ?? pack.data?.sessions.filter((s) => ymdIn(Date.parse(s.scheduledStart), tz) === today) ?? []).map((s) => withLocal(s, local));
  const live = all.filter((s) => s.status === 'live');
  const ready = all.filter((s) => canStartNow(s, now));
  const later = all.filter((s) => s.status === 'scheduled' && !canStartNow(s, now) && Date.parse(s.scheduledStart) > now);

  if (!q.data && !pack.data && q.isPending) return <Screen scroll={false}><Header title="Take attendance" /><Loading /></Screen>;

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header title="Take attendance" />
      {live.length ? (
        <>
          <SectionLabel>Running now</SectionLabel>
          <View style={{ gap: 10 }}>
            {live.map((s) => (
              <SessionCard key={s.id} s={s} tz={tz ?? 'UTC'} />
            ))}
          </View>
        </>
      ) : null}
      <SectionLabel>Ready to start</SectionLabel>
      {ready.length ? (
        <View style={{ gap: 10 }}>
          {ready.map((s) => (
            <SessionCard key={s.id} s={s} tz={tz ?? 'UTC'} />
          ))}
        </View>
      ) : (
        <Empty title="Nothing to start right now" message="Classes can be started from 2 hours before until they end. Need a class that isn’t on the timetable?" />
      )}
      <Button title="Add an extra class" kind="secondary" onPress={() => router.push('/extra-class')} icon={<Plus color={colors.text} size={16} />} style={{ marginTop: 14 }} />
      {later.length ? (
        <>
          <SectionLabel>Later today</SectionLabel>
          <View style={{ gap: 10 }}>
            {later.map((s) => (
              <SessionCard key={s.id} s={s} tz={tz ?? 'UTC'} />
            ))}
          </View>
        </>
      ) : null}
      {!q.data && pack.data ? (
        <Text variant="small" style={{ marginTop: 16 }}>
          Offline — showing classes saved on this phone.
        </Text>
      ) : null}
    </Screen>
  );
}
