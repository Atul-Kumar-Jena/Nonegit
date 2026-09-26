import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, Minus, Plus } from 'lucide-react-native';
import { minToAttendOfNext, type HistoryItem } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Card, ErrorState, IconButton, Loading, ProgressBar, SectionLabel, Text } from '@kit/components/ui';
import { dayLabel, pct, zoned, clock } from '@kit/lib/format';
import { colors, fonts, radius, toneColor } from '@kit/theme';
import { ChangeNote } from '@/components/ChangeNote';
import { useSubjectDetail } from '@/state/queries';

/** Subject detail — standing, "how much to attend" planner, and full history. */
export default function SubjectDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useSubjectDetail(String(id ?? ''));
  const [y, setY] = useState(10);
  const [x, setX] = useState(10);

  useEffect(() => {
    if (!q.data) return;
    const n = q.data.remainingThisTerm && q.data.remainingThisTerm > 0 ? q.data.remainingThisTerm : 10;
    setY(n);
    setX(n);
  }, [q.data?.subject.courseId]);

  const header = (
    <IconButton label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/subjects'))}>
      <ArrowLeft color={colors.text} size={18} />
    </IconButton>
  );

  const counts = useMemo(() => {
    const c = { present: 0, absent: 0, cancelled: 0 };
    for (const h of q.data?.history ?? []) if (h.status in c) c[h.status as keyof typeof c]++;
    return c;
  }, [q.data]);

  if (q.isPending) return <Screen scroll={false}>{header}<Loading /></Screen>;
  if (q.isError && !q.data)
    return (
      <Screen>
        {header}
        <View style={{ marginTop: 24 }}>
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        </View>
      </Screen>
    );

  const d = q.data!;
  const s = d.subject;
  const min = d.minPercent;
  const risk = s.standing === 'at-risk';
  const projected = s.held + y > 0 ? ((s.attended + x) / (s.held + y)) * 100 : null;
  const need = minToAttendOfNext(s.attended, s.held, y, min);
  const impossible = need > y;

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      {header}
      <View style={{ marginTop: 16, gap: 4 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Text variant="monoSmall">{s.code}</Text>
          {risk ? <Badge label="AT RISK" tone="amber" /> : s.standing === 'safe' ? <Badge label="On track" tone="green" /> : null}
          {s.kind === 'lab' ? <Badge label="Lab" tone="violet" dot={false} /> : null}
        </View>
        <Text variant="title">{s.title}</Text>
        {s.instructor ? <Text variant="small">{s.instructor}</Text> : null}
      </View>

      <Card tone={risk ? 'amber' : undefined} style={{ marginTop: 18 }}>
        <View style={styles.between}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
            <Text variant="display" color={risk ? colors.amber : colors.text}>
              {pct(s.percent)}
            </Text>
            {s.percent !== null ? <Text style={styles.pctSign}>%</Text> : null}
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text variant="mono">
              {s.attended} / {s.held}
            </Text>
            <Text variant="monoSmall">attended</Text>
          </View>
        </View>
        <View style={{ marginTop: 12 }}>
          <ProgressBar value={s.percent} marker={min} tone={risk ? 'amber' : 'cyan'} />
        </View>
        <Text variant="small" style={{ marginTop: 12 }} color={risk ? colors.amber : colors.textMuted}>
          {s.standing === 'no-data'
            ? 'No classes held yet this term.'
            : risk
              ? s.needToReach >= 10_000
                ? `${pct(min)}% can no longer be reached this term. Talk to your instructor.`
                : `Attend the next ${s.needToReach} ${s.needToReach === 1 ? 'class' : 'classes'} in a row to get back to ${pct(min)}%.`
              : s.safeToMiss > 0
                ? `You can miss ${s.safeToMiss} ${s.safeToMiss === 1 ? 'class' : 'classes'} and still stay at or above ${pct(min)}%.`
                : `You're exactly at the limit — don’t miss the next class.`}
        </Text>
      </Card>

      <SectionLabel>Plan ahead</SectionLabel>
      <Card style={{ gap: 14 }}>
        <Stepper label="Upcoming classes" value={y} min={1} max={200} onChange={(v) => { setY(v); setX((cur) => Math.min(cur, v)); }} />
        <Stepper label="I will attend" value={x} min={0} max={y} onChange={setX} />
        <View style={styles.planOut}>
          <Text variant="small">Your attendance would be</Text>
          <Text style={[styles.planPct, { color: projected !== null && projected < min ? colors.amber : colors.green }]}>{pct(projected === null ? null : Math.round(projected * 10) / 10)}%</Text>
        </View>
        <Text variant="small" color={impossible ? colors.red : colors.textMuted}>
          {impossible
            ? `Even attending all ${y} won’t reach ${pct(min)}% — you’d need ${need}.`
            : need === 0
              ? `You stay at or above ${pct(min)}% even if you miss all ${y}.`
              : `Attend at least ${need} of the next ${y} to finish at or above ${pct(min)}%.`}
        </Text>
        {d.remainingThisTerm !== null ? (
          <Text variant="monoSmall">{d.remainingThisTerm} upcoming classes are already on the timetable.</Text>
        ) : null}
      </Card>

      <SectionLabel right={<Text variant="monoSmall">{`${counts.present} present · ${counts.absent} absent`}</Text>}>History</SectionLabel>
      {d.history.length === 0 ? (
        <Card>
          <Text variant="small">No classes yet.</Text>
        </Card>
      ) : (
        <Card padded={false}>
          {d.history.map((h, i) => (
            <HistoryRow key={h.sessionId} h={h} tz={d.timezone} first={i === 0} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

function HistoryRow({ h, tz, first }: { h: HistoryItem; tz: string; first: boolean }) {
  const tone = h.status === 'present' ? 'green' : h.status === 'absent' ? 'red' : h.status === 'live' ? 'cyan' : 'muted';
  const label = { present: 'Present', absent: 'Absent', cancelled: 'Cancelled', upcoming: 'Upcoming', live: 'Live now' }[h.status];
  const how = h.status === 'present' ? (h.source === 'manual' ? 'Register' : h.source === 'review' ? 'Approved' : h.offline ? 'QR · offline' : 'QR') : null;
  return (
    <View style={[styles.hist, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
      <View style={[styles.dot, { backgroundColor: toneColor[tone].fg }]} />
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong">
          {dayLabel(h.scheduledStart, tz)} · {clock(h.scheduledStart, tz)}
        </Text>
        <Text variant="small">{[h.lectureNo ? `Lecture ${h.lectureNo}` : null, h.room, how].filter(Boolean).join(' · ') || ' '}</Text>
        <ChangeNote change={h.change} tz={tz} />
      </View>
      <Badge label={label} tone={tone} dot={false} />
    </View>
  );
}

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <View style={styles.between}>
      <Text variant="body" color={colors.text}>
        {label}
      </Text>
      <View style={styles.stepper}>
        <Pressable onPress={() => onChange(Math.max(min, value - 1))} disabled={value <= min} accessibilityRole="button" accessibilityLabel={`Decrease ${label}`} style={styles.stepBtn} hitSlop={6}>
          <Minus color={value <= min ? colors.textDim : colors.text} size={16} />
        </Pressable>
        <Text style={styles.stepVal}>{value}</Text>
        <Pressable onPress={() => onChange(Math.min(max, value + 1))} disabled={value >= max} accessibilityRole="button" accessibilityLabel={`Increase ${label}`} style={styles.stepBtn} hitSlop={6}>
          <Plus color={value >= max ? colors.textDim : colors.text} size={16} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pctSign: { fontFamily: fonts.semibold, fontSize: 18, color: colors.textMuted, marginBottom: 8, marginLeft: 2 },
  planOut: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  planPct: { fontFamily: fonts.bold, fontSize: 26, letterSpacing: -0.6 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: { width: 36, height: 36, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgRaised },
  stepVal: { fontFamily: fonts.monoMedium, fontSize: 16, color: colors.text, minWidth: 36, textAlign: 'center' },
  hist: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
