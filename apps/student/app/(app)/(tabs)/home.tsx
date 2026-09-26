import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { CalendarDays, ChevronRight, ClipboardList, MapPin, ScanLine, TrendingDown, TrendingUp } from 'lucide-react-native';
import type { DashboardResponse, TodaySession } from '@attendly/protocol';
import { NotificationBell } from '@kit/components/NotificationBell';
import { Screen } from '@kit/components/Screen';
import { usePermissionsOnboarding } from '@kit/lib/notifications';
import { SyncBanner } from '@kit/components/SyncBanner';
import { Avatar, Badge, Card, ErrorState, Loading, ProgressBar, SectionLabel, Text } from '@kit/components/ui';
import { clock, dayLabel, greeting, initials, pct, timeRange } from '@kit/lib/format';
import { integrityReport } from '@kit/lib/device-info';
import { ensureLocationPermission, locationStatus } from '@kit/lib/location';
import { ChangeNote } from '@/components/ChangeNote';
import { useDashboard, useTimetable } from '@/state/queries';
import { useApi } from '@kit/state/session';
import { colors, fonts, toneColor } from '@kit/theme';

/** 04 · Home dashboard — today's classes and term attendance. */
export default function Home() {
  usePermissionsOnboarding();
  const q = useDashboard();
  const api = useApi();
  const [gps, setGps] = useState<'ready' | 'permission' | 'off' | null>(null);
  const [rooted, setRooted] = useState<boolean | null>(null);

  useFocusEffect(
    useCallback(() => {
      void locationStatus().then(setGps);
      void integrityReport().then((r) => setRooted(r.rooted));
    }, []),
  );

  if (q.isPending) return <Screen scroll={false}><Loading label="Syncing securely…" /></Screen>;
  if (q.isError && !q.data)
    return (
      <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
        <View style={{ marginTop: 40 }}>
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        </View>
      </Screen>
    );

  const d = q.data!;
  const offline = q.isError || q.fetchStatus === 'paused';
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header d={d} />
      <TermCard d={d} offline={offline} updatedAt={q.dataUpdatedAt} />
      <SyncBanner />
      {gps && gps !== 'ready' ? (
        <Pressable
          onPress={() =>
            gps === 'permission'
              ? void ensureLocationPermission().then((r) => {
                  if (r === 'blocked') void Linking.openSettings();
                  void locationStatus().then(setGps);
                })
              : void Linking.openSettings()
          }
          accessibilityRole="button"
          style={{ marginTop: 12 }}
        >
          <Card tone="amber" style={styles.link}>
            <MapPin color={colors.amber} size={18} />
            <Text variant="small" style={{ flex: 1 }}>
              {gps === 'permission' ? 'Allow location so your scans can be checked in the classroom. Tap to allow.' : 'Location is off. Turn it on to scan attendance.'}
            </Text>
            <ChevronRight color={colors.textDim} size={18} />
          </Card>
        </Pressable>
      ) : null}
      {rooted ? (
        <View style={{ marginTop: 12 }}>
          <Card tone="red">
            <Text variant="small">This phone looks rooted or modified, so attendance scans will be refused.</Text>
          </Card>
        </View>
      ) : null}

      <SectionLabel right={<Text variant="monoSmall">{d.today.length} {d.today.length === 1 ? 'class' : 'classes'}</Text>}>
        {`Today · ${dayLabel(d.serverTime, d.timezone)}`}
      </SectionLabel>
      {d.today.length === 0 ? (
        <Card>
          <Text variant="small">No classes scheduled today. Enjoy the break.</Text>
        </Card>
      ) : (
        <View style={{ gap: 10 }}>
          {d.today.map((s) => (
            <SessionCard key={s.sessionId} s={s} tz={d.timezone} now={api.serverNow()} />
          ))}
        </View>
      )}
      <ComingUp tz={d.timezone} today={dayLabel(d.serverTime, d.timezone)} />
      <Pressable onPress={() => router.push('/timetable')} accessibilityRole="button" style={{ marginTop: 10 }}>
        <Card style={styles.link}>
          <CalendarDays color={colors.cyan} size={18} />
          <Text variant="bodyStrong" style={{ flex: 1 }}>
            Full timetable & next 7 days
          </Text>
          <ChevronRight color={colors.textDim} size={18} />
        </Card>
      </Pressable>
    </Screen>
  );
}

/** The next scheduled classes after today (moved / extra / cancelled ones included). */
function ComingUp({ tz, today }: { tz: string; today: string }) {
  const t = useTimetable();
  const next = (t.data?.upcoming ?? []).filter((u) => dayLabel(u.scheduledStart, tz) !== today).slice(0, 5);
  if (!next.length) return null;
  return (
    <>
      <SectionLabel>Coming up</SectionLabel>
      <Card padded={false}>
        {next.map((u, i) => (
          <Pressable
            key={u.sessionId}
            onPress={() => router.push({ pathname: '/subject/[id]', params: { id: u.courseId } })}
            accessibilityRole="button"
            style={[styles.upRow, i < next.length - 1 && styles.upDivider, u.status === 'cancelled' && { opacity: 0.55 }]}
          >
            <View style={{ width: 86 }}>
              <Text variant="monoSmall">{dayLabel(u.scheduledStart, tz)}</Text>
              <Text variant="bodyStrong">{clock(u.scheduledStart, tz)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {u.courseCode} · {u.courseTitle}
              </Text>
              <Text variant="small" numberOfLines={1}>
                {u.room ?? 'Room to be announced'}
              </Text>
              <ChangeNote change={u.change} tz={tz} />
            </View>
          </Pressable>
        ))}
      </Card>
    </>
  );
}

function Header({ d }: { d: DashboardResponse }) {
  return (
    <View style={styles.header}>
      <Pressable onPress={() => router.push('/profile')} accessibilityRole="button" accessibilityLabel="Open profile">
        <Avatar text={initials(d.user.fullName)} size={42} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text variant="small">{greeting()},</Text>
        <Text variant="heading" numberOfLines={1}>
          {d.user.fullName}
        </Text>
      </View>
      <NotificationBell />
    </View>
  );
}

function TermCard({ d, offline, updatedAt }: { d: DashboardResponse; offline: boolean; updatedAt: number }) {
  const { term } = d;
  const risk = term.percent !== null && term.percent < term.minPercent;
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const ago = Math.round((Date.now() - updatedAt) / 60_000);
  return (
    <Card style={{ marginTop: 18 }}>
      <View style={styles.between}>
        <Text variant="label">Term attendance</Text>
        {offline ? <Badge label={`Offline · ${ago}m old`} tone="amber" /> : <Badge label="Synced" tone="cyan" />}
      </View>
      <View style={[styles.between, { alignItems: 'flex-end', marginTop: 10 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
          <Text variant="display" color={risk ? colors.amber : colors.text}>
            {pct(term.percent)}
          </Text>
          {term.percent !== null ? (
            <Text style={{ fontFamily: fonts.semibold, fontSize: 18, color: colors.textMuted, marginBottom: 8, marginLeft: 2 }}>%</Text>
          ) : null}
        </View>
        {term.weekDelta !== null && Math.abs(term.weekDelta) >= 0.05 ? (
          <View style={[styles.delta, { borderColor: term.weekDelta >= 0 ? toneColor.green.line : toneColor.amber.line, backgroundColor: term.weekDelta >= 0 ? toneColor.green.bg : toneColor.amber.bg }]}>
            {term.weekDelta >= 0 ? <TrendingUp color={colors.green} size={13} /> : <TrendingDown color={colors.amber} size={13} />}
            <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: term.weekDelta >= 0 ? colors.green : colors.amber }}>
              {term.weekDelta >= 0 ? '+' : ''}
              {term.weekDelta.toFixed(1)} this wk
            </Text>
          </View>
        ) : null}
      </View>
      <View style={{ marginTop: 14 }}>
        <ProgressBar value={term.percent} marker={term.minPercent} tone={risk ? 'amber' : 'cyan'} />
      </View>
      <View style={[styles.between, { marginTop: 10 }]}>
        <Text variant="monoSmall">
          {term.attended} of {term.held} sessions
        </Text>
        <Text variant="monoSmall">min {pct(term.minPercent)}%</Text>
      </View>
    </Card>
  );
}

/** Scans open 15 min before a scheduled class and close 15 min after it (the server enforces the same window). */
const GRACE_MS = 15 * 60_000;

function SessionCard({ s, tz, now }: { s: TodaySession; tz: string; now: number }) {
  const live = s.status === 'live';
  const manual = s.mode === 'manual';
  const inWindow = s.status === 'scheduled' && now >= Date.parse(s.scheduledStart) - GRACE_MS && now <= Date.parse(s.scheduledEnd) + GRACE_MS;
  const canScan = !manual && !s.marked && (live || inWindow);
  return (
    <Card style={[styles.session, live && { borderColor: 'rgba(255, 255, 255, 0.35)' }]} padded={false}>
      <View style={[styles.accent, { backgroundColor: live ? colors.cyan : s.marked ? colors.green : colors.borderHi }]} />
      <View style={{ flex: 1, paddingVertical: 14, paddingLeft: 14, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="monoSmall">{s.courseCode}</Text>
          {live ? <Badge label="LIVE" tone="cyan" /> : null}
          {manual ? <Badge label="Paper register" tone="violet" dot={false} icon={<ClipboardList color={colors.violet} size={11} />} /> : null}
          {s.status === 'cancelled' ? <Badge label="Cancelled" tone="red" dot={false} /> : null}
        </View>
        <Text variant="bodyStrong" numberOfLines={1}>
          {s.courseTitle}
        </Text>
        <Text variant="small" numberOfLines={1}>
          {timeRange(s.scheduledStart, s.scheduledEnd, tz)}
          {s.room ? ` · ${s.room}` : ''}
        </Text>
        <ChangeNote change={s.change} tz={tz} />
      </View>
      <View style={{ paddingRight: 14 }}>
        {canScan ? (
          <Pressable
            onPress={() => router.push({ pathname: '/scan', params: { course: `${s.courseCode} · ${s.courseTitle}` } })}
            accessibilityRole="button"
            accessibilityLabel={`Scan for ${s.courseTitle}`}
            style={({ pressed }) => [styles.scanBtn, { opacity: pressed ? 0.8 : 1 }]}
          >
            <ScanLine color="#0a0a0a" size={15} strokeWidth={2.4} />
            <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: '#0a0a0a' }}>Scan</Text>
          </Pressable>
        ) : s.marked ? (
          <Badge label="Present" tone="green" />
        ) : s.status === 'closed' ? (
          <Badge label="Missed" tone="amber" dot={false} />
        ) : manual && s.status !== 'cancelled' ? (
          <Badge label="Teacher marks" tone="muted" dot={false} />
        ) : s.status === 'scheduled' ? (
          <Badge label="Upcoming" tone="muted" dot={false} />
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  upRow: { flexDirection: 'row', gap: 12, padding: 14, alignItems: 'center' },
  upDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  delta: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  tile: { flexBasis: '47%', flexGrow: 1, padding: 14 },
  tileWrap: { flexBasis: '47%', flexGrow: 1 },
  tileInner: { padding: 14, flex: 1 },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  session: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  accent: { width: 3, alignSelf: 'stretch' },
  link: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  scanBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.cyan, borderRadius: 11, paddingHorizontal: 14, paddingVertical: 9 },
});
