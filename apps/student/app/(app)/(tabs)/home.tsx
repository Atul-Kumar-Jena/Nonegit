import { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { CalendarDays, ChevronRight, ClipboardList, MapPin, ScanLine, TrendingDown, TrendingUp } from 'lucide-react-native';
import type { DashboardResponse, TodaySession } from '@attendly/protocol';
import { NotificationBell } from '@kit/components/NotificationBell';
import { Screen } from '@kit/components/Screen';
import { BatteryCard } from '@kit/components/BatteryCard';
import { NoticeHomeCard } from '@kit/components/Notices';
import { usePermissionsOnboarding } from '@kit/lib/notifications';
import { SyncBanner } from '@kit/components/SyncBanner';
import { Avatar, Badge, Card, ErrorState, Loading, ProgressBar, SectionLabel, Text } from '@kit/components/ui';
import { clock, dayLabel, greeting, initials, pct, timeRange } from '@kit/lib/format';
import { integrityReport } from '@kit/lib/device-info';
import { ensureLocationPermission, locationStatus } from '@kit/lib/location';
import { ChangeNote } from '@/components/ChangeNote';
import { useDashboard, useSubjects, useTimetable } from '@/state/queries';
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
      <HeadsUp />
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
      <BatteryCard />
      <NoticeHomeCard />
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

/**
 * Recommendations from the student's own numbers: the subjects below the minimum (how many
 * classes in a row get them back) and the ones with no margin left. Tap to open the subject.
 */
function HeadsUp() {
  const subs = useSubjects().data;
  if (!subs) return null;
  const below = subs.subjects.filter((s) => s.standing === 'at-risk').sort((a, b) => b.needToReach - a.needToReach);
  const edge = subs.subjects.filter((s) => s.standing === 'safe' && s.safeToMiss === 0);
  if (!below.length && !edge.length) return null;
  const tips = [
    ...below.slice(0, 3).map((s) => ({ s, text: `${s.code} is at ${pct(s.percent)}% — attend the next ${s.needToReach} ${s.needToReach === 1 ? 'class' : 'classes'} in a row to get back to ${pct(subs.minPercent)}%.`, tone: colors.red })),
    ...edge.slice(0, Math.max(0, 3 - below.length)).map((s) => ({ s, text: `${s.code}: no class can be missed right now without dropping below ${pct(subs.minPercent)}%.`, tone: colors.amber })),
  ];
  return (
    <Card tone={below.length ? 'amber' : undefined} style={{ marginTop: 12, gap: 8 }}>
      <Text variant="label">Heads-up</Text>
      {tips.map(({ s, text, tone }) => (
        <Pressable key={s.courseId} onPress={() => router.push({ pathname: '/subject/[id]', params: { id: s.courseId } })} accessibilityRole="button">
          <Text variant="small" color={tone}>
            {text}
          </Text>
        </Pressable>
      ))}
    </Card>
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
  const canScan = !manual && !s.marked && !s.waitingForProfessor && (live || inWindow);
  return (
    <Card style={[styles.session, live && { borderColor: 'rgba(255, 255, 255, 0.35)' }]} padded={false}>
      <View style={[styles.accent, { backgroundColor: live ? colors.cyan : s.marked ? colors.green : colors.borderHi }]} />
      <View style={{ flex: 1, paddingVertical: 14, paddingLeft: 14, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="monoSmall">{s.courseCode}</Text>
          {live ? <Badge label={s.lateMin ? `LIVE · started ${s.lateMin} min late` : 'LIVE'} tone="cyan" /> : null}
          {s.waitingForProfessor ? <Badge label="Waiting for the professor" tone="amber" dot={false} /> : null}
          {s.missed ? <Badge label="Not held" tone="red" dot={false} /> : null}
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
        {s.taking && !s.marked ? (
          <View style={styles.taking}>
            <View style={styles.takingDot} />
            <Text style={styles.takingText}>
              {s.rounds && s.rounds.done < s.rounds.open ? `Round ${s.rounds.open} of ${s.rounds.required} — scan now` : 'Attendance being taken — scan now'}
            </Text>
          </View>
        ) : null}
        {s.rounds && !s.marked && live ? (
          <Text variant="small" color={colors.amber}>
            {`${s.rounds.done} of ${s.rounds.required} scans done · present only after all ${s.rounds.required} — stay till the end`}
          </Text>
        ) : null}
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
  taking: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 999, alignSelf: 'flex-start', backgroundColor: 'rgba(74,222,128,0.14)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.45)' },
  takingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  takingText: { fontFamily: fonts.semibold, fontSize: 12.5, color: colors.green },
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
