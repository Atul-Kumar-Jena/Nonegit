import { useCallback, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ChevronRight, CloudDownload, Inbox, Plus, Radio, ShieldAlert, Smartphone, UserCheck, UserPlus, Wand2 } from 'lucide-react-native';
import { NotificationBell } from '@kit/components/NotificationBell';
import { Screen } from '@kit/components/Screen';
import { BatteryCard } from '@kit/components/BatteryCard';
import { NoticeHomeCard } from '@kit/components/Notices';
import { usePermissionsOnboarding } from '@kit/lib/notifications';
import { SyncBanner } from '@kit/components/SyncBanner';
import { Avatar, Badge, Button, Card, ErrorState, Loading, SectionLabel, Text } from '@kit/components/ui';
import { dayLabel, greeting, initials, timeAgo, clock } from '@kit/lib/format';
import { colors, fonts, toneColor, type Tone } from '@kit/theme';
import { SessionCard } from '@/components/SessionCard';
import { Empty } from '@/components/forms';
import { useLocalSessions, withLocal } from '@/local-sessions';
import { useChangeRequests, useMe, useOfflinePack, useOverview, useSessionsOn } from '@/queries';
import { addDays } from '@/components/forms';
import { RequestsBanner } from '@/components/Requests';
import { useSetupProgress } from '@/setup';
import { ymdIn } from '@/time';
import { useApi } from '@kit/state/session';

/** Today — what's running, what's next, and anything that needs you. */
export default function Today() {
  usePermissionsOnboarding();
  const me = useMe();
  // Role / permissions may have just been changed by an admin: re-check whenever this tab is shown.
  useFocusEffect(useCallback(() => void me.refetch(), [me.refetch]));
  const q = useOverview();
  const pack = useOfflinePack();
  const local = useLocalSessions();
  const reqs = useChangeRequests();

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
  const perms = me.data?.permissions ?? [];
  const planner = admin || perms.includes('planner');
  const devices = admin || perms.includes('devices');

  return (
    <Screen
      onRefresh={() => {
        void q.refetch();
        void pack.refetch();
        void me.refetch();
        void reqs.refetch();
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
        {user ? <Badge label={admin ? 'Admin · Principal / HOD' : perms.length ? `Professor · +${perms.length}` : 'Professor'} tone={admin ? 'violet' : 'cyan'} dot={false} /> : null}
        <NotificationBell />
      </View>

      {admin ? <SetupNudge /> : null}

      <RequestsBanner requests={reqs.data?.incoming ?? []} tz={tz} />
      <BatteryCard />
      <NoticeHomeCard />

      <SyncBanner />

      {d && (d.liveNow || (devices && (d.flaggedOpen || d.pendingRequests))) ? (
        <View style={styles.needs}>
          {d.liveNow ? <Pill icon={<Radio color={colors.green} size={13} />} label={`${d.liveNow} live now`} /> : null}
          {devices && d.flaggedOpen ? <Pill icon={<ShieldAlert color={colors.amber} size={13} />} label={`${d.flaggedOpen} suspicious ${d.flaggedOpen === 1 ? 'scan' : 'scans'}`} onPress={() => router.push('/flags')} /> : null}
          {devices && d.pendingRequests ? <Pill icon={<Smartphone color={colors.text} size={13} />} label={`${d.pendingRequests} phone ${d.pendingRequests === 1 ? 'request' : 'requests'}`} onPress={() => router.push('/requests')} /> : null}
        </View>
      ) : null}

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
      <ComingUp from={addDays(today, 1)} tz={tz} />
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <Button title="Extra class" kind="secondary" onPress={() => router.push('/extra-class')} icon={<Plus color={colors.text} size={16} />} style={{ flex: 1 }} />
        {planner ? (
          <Button title="Cover a class" kind="secondary" onPress={() => router.push('/cover')} icon={<UserPlus color={colors.text} size={16} />} style={{ flex: 1 }} />
        ) : (
          <Button title="Requests" kind="secondary" onPress={() => router.push('/inbox')} icon={<Inbox color={colors.text} size={16} />} style={{ flex: 1 }} />
        )}
      </View>
      <Pressable onPress={() => void pack.refetch()} accessibilityRole="button" style={[styles.row, { marginTop: 22 }]}>
        <CloudDownload color={pack.data ? colors.green : colors.textDim} size={15} />
        <Text variant="small" style={{ flex: 1 }}>
          {pack.data
            ? `Ready offline · ${pack.data.sessions.length} ${pack.data.sessions.length === 1 ? 'class' : 'classes'} of yours (today & tomorrow) saved · ${timeAgo(new Date(pack.data.generatedAt).toISOString())}`
            : pack.isFetching
              ? 'Downloading today’s classes for offline use…'
              : 'Not ready offline yet — tap to download.'}
        </Text>
      </Pressable>
    </Screen>
  );
}

/** Classes scheduled for the next days (yours, or everyone's for an admin). */
function ComingUp({ from, tz }: { from: string; tz?: string }) {
  const q = useSessionsOn(from, 7);
  const next = (q.data ?? []).filter((s) => s.status === 'scheduled' || s.status === 'cancelled').slice(0, 6);
  if (!next.length) return null;
  return (
    <>
      <SectionLabel>Coming up</SectionLabel>
      <Card padded={false}>
        {next.map((s, i) => (
          <Pressable
            key={s.id}
            onPress={() => router.push({ pathname: '/session/[id]', params: { id: s.id } })}
            accessibilityRole="button"
            style={[styles.upRow, i < next.length - 1 && styles.upDivider, s.status === 'cancelled' && { opacity: 0.55 }]}
          >
            <View style={{ width: 86 }}>
              <Text variant="monoSmall">{dayLabel(s.scheduledStart, tz)}</Text>
              <Text variant="bodyStrong">{clock(s.scheduledStart, tz)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {s.courseCode} · {s.courseTitle}
              </Text>
              <Text variant="small" numberOfLines={1}>
                {[s.roomLabel, s.substitute ? `${s.substitute.name} (covering)` : s.teacher?.name, s.status === 'cancelled' ? 'Cancelled' : null].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </Pressable>
        ))}
      </Card>
    </>
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

function Pill({ icon, label, onPress }: { icon: ReactNode; label: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : 'text'} style={styles.pill}>
      {icon}
      <Text variant="small" color={colors.text}>
        {label}
      </Text>
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
  upRow: { flexDirection: 'row', gap: 12, padding: 14, alignItems: 'center' },
  upDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  needs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  tileWrap: { flexBasis: '47%', flexGrow: 1 },
  tile: { padding: 14 },
});
