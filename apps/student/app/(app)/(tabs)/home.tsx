import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Clock3, MapPin, ScanLine, ShieldCheck, Smartphone, TrendingDown, TrendingUp } from 'lucide-react-native';
import type { DashboardResponse, TodaySession } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Avatar, Badge, Card, ErrorState, Loading, ProgressBar, SectionLabel, Text } from '@kit/components/ui';
import { dayLabel, drift, greeting, initials, pct, shortFingerprint, timeRange } from '@kit/lib/format';
import { integrityReport } from '@kit/lib/device-info';
import { locationStatus } from '@kit/lib/location';
import { useDashboard } from '@/state/queries';
import { useApi } from '@kit/state/session';
import { colors, fonts, toneColor } from '@kit/theme';

/** 04 · Home dashboard — today's classes and term attendance. */
export default function Home() {
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
  const offline = q.isError;
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header d={d} />
      <TermCard d={d} offline={offline} updatedAt={q.dataUpdatedAt} />
      <View style={styles.grid}>
        <Tile icon={<Smartphone color={colors.textMuted} size={14} />} label="Device" value="Bound" tone="green" sub={`HWID ${shortFingerprint(d.device.fingerprint)}`} />
        <Tile
          icon={<MapPin color={colors.textMuted} size={14} />}
          label="GPS"
          value={gps === 'ready' ? 'Ready' : gps === 'permission' ? 'Allow' : gps === 'off' ? 'Off' : '…'}
          tone={gps === 'ready' ? 'green' : 'amber'}
          sub={gps === 'ready' ? 'Precise · on demand' : gps === 'permission' ? 'Asked when you scan' : 'Turn on location'}
        />
        <Tile
          icon={<ShieldCheck color={colors.textMuted} size={14} />}
          label="Integrity"
          value={rooted === null ? '…' : rooted ? 'Fail' : 'Pass'}
          tone={rooted ? 'amber' : 'green'}
          sub={rooted ? 'Rooted device detected' : 'Key sealed · signed'}
        />
        <DriftTile driftMs={api.clockDriftMs()} />
      </View>

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
            <SessionCard key={s.sessionId} s={s} tz={d.timezone} />
          ))}
        </View>
      )}
    </Screen>
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
      <Badge label={d.user.institution.name.length > 18 ? d.user.institution.slug.toUpperCase() : d.user.institution.name} tone="muted" dot={false} />
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

function Tile({ icon, label, value, sub, tone }: { icon: ReactNode; label: string; value: string; sub: string; tone: 'green' | 'amber' | 'cyan' }) {
  return (
    <Card style={styles.tile}>
      <View style={styles.tileHead}>
        {icon}
        <Text variant="label">{label}</Text>
      </View>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 16, color: toneColor[tone].fg, marginTop: 8 }}>{value}</Text>
      <Text variant="monoSmall" numberOfLines={1} style={{ marginTop: 2 }}>
        {sub}
      </Text>
    </Card>
  );
}

function DriftTile({ driftMs }: { driftMs: number | null }) {
  const bad = driftMs !== null && Math.abs(driftMs) > 30_000;
  return (
    <Tile
      icon={<Clock3 color={colors.textMuted} size={14} />}
      label="Time drift"
      value={drift(driftMs)}
      tone={bad ? 'amber' : 'green'}
      sub={bad ? 'Auto-corrected' : 'Server-synced'}
    />
  );
}

function SessionCard({ s, tz }: { s: TodaySession; tz: string }) {
  const live = s.status === 'live';
  const canScan = live && !s.marked;
  return (
    <Card style={[styles.session, live && { borderColor: 'rgba(34,211,238,0.35)' }]} padded={false}>
      <View style={[styles.accent, { backgroundColor: live ? colors.cyan : s.marked ? colors.green : colors.borderHi }]} />
      <View style={{ flex: 1, paddingVertical: 14, paddingLeft: 14, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="monoSmall">{s.courseCode}</Text>
          {live ? <Badge label="LIVE" tone="cyan" /> : null}
          {s.status === 'cancelled' ? <Badge label="Cancelled" tone="red" dot={false} /> : null}
        </View>
        <Text variant="bodyStrong" numberOfLines={1}>
          {s.courseTitle}
        </Text>
        <Text variant="small" numberOfLines={1}>
          {timeRange(s.scheduledStart, s.scheduledEnd, tz)}
          {s.room ? ` · ${s.room}` : ''}
        </Text>
      </View>
      <View style={{ paddingRight: 14 }}>
        {canScan ? (
          <Pressable
            onPress={() => router.push({ pathname: '/scan', params: { course: `${s.courseCode} · ${s.courseTitle}` } })}
            accessibilityRole="button"
            accessibilityLabel={`Scan for ${s.courseTitle}`}
            style={({ pressed }) => [styles.scanBtn, { opacity: pressed ? 0.8 : 1 }]}
          >
            <ScanLine color="#04141c" size={15} strokeWidth={2.4} />
            <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: '#04141c' }}>Scan</Text>
          </Pressable>
        ) : s.marked ? (
          <Badge label="Present" tone="green" />
        ) : s.status === 'closed' ? (
          <Badge label="Missed" tone="amber" dot={false} />
        ) : s.status === 'scheduled' ? (
          <Badge label="Upcoming" tone="muted" dot={false} />
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  delta: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4, marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  tile: { flexBasis: '47%', flexGrow: 1, padding: 14 },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  session: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  accent: { width: 3, alignSelf: 'stretch' },
  scanBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.cyan, borderRadius: 11, paddingHorizontal: 14, paddingVertical: 9 },
});
