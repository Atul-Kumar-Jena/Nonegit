import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, CloudDownload, Plus, Radio, ShieldAlert, Smartphone, UserCheck, Wand2 } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { SyncBanner } from '@kit/components/SyncBanner';
import { Avatar, Badge, Button, Card, ErrorState, Loading, SectionLabel, Text } from '@kit/components/ui';
import { dayLabel, greeting, initials, timeAgo } from '@kit/lib/format';
import { colors, fonts, toneColor, type Tone } from '@kit/theme';
import { SessionCard } from '@/components/SessionCard';
import { Empty } from '@/components/forms';
import { useLocalSessions, withLocal } from '@/local-sessions';
import { useMe, useOfflinePack, useOverview } from '@/queries';
import { useSetupProgress } from '@/setup';
import { ymdIn } from '@/time';
import { useApi } from '@kit/state/session';

/** Today — what's running, what's next, and anything that needs you. */
export default function Today() {
  const me = useMe();
  const q = useOverview();
  const pack = useOfflinePack();
  const local = useLocalSessions();

  const api = useApi();
  const tz = q.data?.timezone ?? pack.data?.timezone;
  const today = ymdIn(api.serverNow(), tz);
  const sessions = q.data?.today ?? pack.data?.sessions.filter((s) => ymdIn(Date.parse(s.scheduledStart), tz) === today) ?? null;
  if (!sessions) {
    if (q.isPending) return <Screen scroll={false}><Loading label="Loading today…" /></Screen>;
    return (
      <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
        <View style={{ marginTop: 40 }}>
          <ErrorState message={q.error?.message ?? 'Couldn’t load today.'} onRetry={() => void q.refetch()} />
        </View>
      </Screen>
    );
  }

  const list = sessions.map((s) => withLocal(s, local));
  const d = q.data;
  const user = me.data?.user;
  const admin = user?.role === 'admin';

  return (
    <Screen
      onRefresh={() => {
        void q.refetch();
        void pack.refetch();
        void me.refetch();
      }}
      refreshing={q.isRefetching}
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.push('/more')} accessibilityRole="button" accessibilityLabel="Open menu">
          <Avatar text={initials(user?.fullName ?? 'A')} size={42} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text variant="small">{greeting()},</Text>
          <Text variant="heading" numberOfLines={1}>
            {user?.fullName ?? '…'}
          </Text>
        </View>
        {user ? <Badge label={admin ? 'Admin' : 'Teacher'} tone={admin ? 'violet' : 'cyan'} dot={false} /> : null}
      </View>

      {admin ? <SetupNudge /> : null}

      <SyncBanner />

      <View style={styles.grid}>
        <Tile icon={<Radio color={colors.cyan} size={14} />} label="Live now" value={d ? String(d.liveNow) : '–'} tone="cyan" />
        <Tile icon={<UserCheck color={colors.green} size={14} />} label="Marked today" value={d ? String(d.markedToday) : '–'} tone="green" />
        <Tile icon={<ShieldAlert color={colors.amber} size={14} />} label="Flags to review" value={d ? String(d.flaggedOpen) : '–'} tone={d?.flaggedOpen ? 'amber' : 'muted'} onPress={() => router.push('/flags')} />
        <Tile
          icon={<Smartphone color={colors.violet} size={14} />}
          label="Phone requests"
          value={d ? String(d.pendingRequests) : '–'}
          tone={d?.pendingRequests ? 'violet' : 'muted'}
          onPress={() => router.push('/requests')}
        />
      </View>

      <Pressable onPress={() => void pack.refetch()} accessibilityRole="button" style={[styles.row, { marginTop: 12 }]}>
        <CloudDownload color={pack.data ? colors.green : colors.textDim} size={15} />
        <Text variant="small" style={{ flex: 1 }}>
          {pack.data
            ? `Ready offline · ${pack.data.sessions.length} upcoming ${pack.data.sessions.length === 1 ? 'class' : 'classes'} saved · ${timeAgo(new Date(pack.data.generatedAt).toISOString())}`
            : pack.isFetching
              ? 'Downloading today’s classes for offline use…'
              : 'Not ready offline yet — tap to download.'}
        </Text>
      </Pressable>

      <SectionLabel right={<Text variant="monoSmall">{`${list.length} ${list.length === 1 ? 'class' : 'classes'}`}</Text>}>
        {`Today · ${dayLabel(d?.serverTime ?? Date.now(), tz)}`}
      </SectionLabel>
      {list.length === 0 ? (
        <Empty
          title="No classes today"
          message={admin ? 'Classes appear here from the timetable. You can also add a one-off class.' : 'Your classes appear here from the timetable.'}
        />
      ) : (
        <View style={{ gap: 10 }}>
          {list.map((s) => (
            <SessionCard key={s.id} s={s} tz={tz ?? 'UTC'} />
          ))}
        </View>
      )}
      <Button title="Add an extra class" kind="secondary" onPress={() => router.push('/extra-class')} icon={<Plus color={colors.text} size={16} />} style={{ marginTop: 14 }} />
    </Screen>
  );
}

function SetupNudge() {
  const setup = useSetupProgress();
  if (!setup.incomplete) return null;
  return (
    <Pressable onPress={() => router.push('/setup')} accessibilityRole="button" style={{ marginTop: 16 }}>
      <Card tone="violet" style={styles.row}>
        <Wand2 color={colors.violet} size={20} />
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">
            Finish setting up · {setup.done}/{setup.total}
          </Text>
          <Text variant="small">Next: {setup.next}</Text>
        </View>
        <ChevronRight color={colors.textDim} size={18} />
      </Card>
    </Pressable>
  );
}

function Tile({ icon, label, value, tone, onPress }: { icon: ReactNode; label: string; value: string; tone: Tone; onPress?: () => void }) {
  const body = (
    <Card style={styles.tile}>
      <View style={styles.row}>
        {icon}
        <Text variant="label">{label}</Text>
      </View>
      <Text style={{ fontFamily: fonts.bold, fontSize: 24, color: tone === 'muted' ? colors.text : toneColor[tone].fg, marginTop: 6 }}>{value}</Text>
    </Card>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} style={styles.tileWrap}>
      {body}
    </Pressable>
  ) : (
    <View style={styles.tileWrap}>{body}</View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  tileWrap: { flexBasis: '47%', flexGrow: 1 },
  tile: { padding: 14 },
});
