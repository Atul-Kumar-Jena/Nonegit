import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react-native';
import type { PunctualityReport } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { DownloadCard } from '@kit/components/Download';
import { Avatar, Badge, Card, ErrorState, Loading, SectionLabel, Text } from '@kit/components/ui';
import { punctualityReportDoc } from '@kit/lib/export';
import { HBars } from '@kit/components/Charts';
import { clock, initials, pct, zoned } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts, radius } from '@kit/theme';
import { staffApi } from '@/api';
import { Chips, Header } from '@/components/forms';
import { qk } from '@/queries';

const PERIODS = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: 'Term (90 d)' },
] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'muted' }> = {
  on_time: { label: 'On time', tone: 'green' },
  late: { label: 'Late', tone: 'amber' },
  missed: { label: 'Not held', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

/**
 * How professors are doing: for every class, when its time came (log 1) and when the professor
 * arrived and started it (log 2). Per professor: on time, late (and by how much), not held.
 * Tap a professor for their classes; download everything as PDF or Excel.
 */
export default function Professors() {
  const api = useApi();
  const [days, setDays] = useState<number>(30);
  const [teacherId, setTeacherId] = useState<string | null>(null);
  const q = useQuery({ queryKey: qk.punctuality(days, teacherId ?? undefined), queryFn: () => staffApi.punctuality(api, { days, teacherId: teacherId ?? undefined }), placeholderData: (p) => p });
  const r = q.data;
  const tz = r?.timezone;
  const one = teacherId ? r?.teachers.find((t) => t.teacherId === teacherId) : undefined;

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header title={one ? one.name : 'Professors'} subtitle="punctuality" />
      <Chips value={days} options={PERIODS} onChange={setDays} />
      {q.isPending ? <Loading /> : null}
      {q.isError && !r ? <ErrorState message={q.error.message} onRetry={() => void q.refetch()} /> : null}
      {r ? (
        <>
          <View style={{ marginTop: 14 }}>
            <DownloadCard
              title={one ? `Download ${one.name}’s record` : 'Download for every professor'}
              hint="Each class: its time, when the professor started it, late minutes, not held or cancelled"
              queryKey={qk.punctuality(days, teacherId ?? undefined)}
              fetch={() => staffApi.punctuality(api, { days, teacherId: teacherId ?? undefined })}
              toDoc={punctualityReportDoc}
            />
          </View>
          {!teacherId ? (
            <>
              {r.teachers.length > 1 ? (
                <Card style={{ gap: 10, marginTop: 14 }}>
                  <Text variant="label">On time · marker at 80%</Text>
                  <HBars
                    rows={r.teachers.map((t) => ({ key: t.teacherId, label: t.name, sub: `${t.late} late · ${t.missed} not held`, value: t.onTimePercent }))}
                    min={80}
                    onPress={setTeacherId}
                  />
                </Card>
              ) : null}
              <SectionLabel>{`${r.teachers.length} professors · lowest on-time first`}</SectionLabel>
              {r.teachers.length === 0 ? <Text variant="small">No classes in this period yet.</Text> : null}
              <View style={{ gap: 8 }}>
                {r.teachers.map((t) => (
                  <Pressable key={t.teacherId} onPress={() => setTeacherId(t.teacherId)} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
                    <Avatar text={initials(t.name) || '?'} size={38} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="bodyStrong" numberOfLines={1}>
                        {t.name}
                      </Text>
                      <Text variant="small">{`${t.onTime} on time · ${t.late} late${t.avgLateMin ? ` (avg ${t.avgLateMin} min)` : ''} · ${t.missed} not held${t.cancelled ? ` · ${t.cancelled} cancelled` : ''}`}</Text>
                    </View>
                    <Text style={[styles.pct, { color: t.onTimePercent === null ? colors.textDim : t.onTimePercent >= 90 ? colors.green : t.onTimePercent >= 70 ? colors.amber : colors.red }]}>
                      {t.onTimePercent === null ? '—' : `${pct(t.onTimePercent)}%`}
                    </Text>
                    <ChevronRight color={colors.textDim} size={16} />
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <>
              {one ? (
                <Card style={styles.summary}>
                  <Stat n={one.onTime} label="on time" color={colors.green} />
                  <Stat n={one.late} label={one.avgLateMin ? `late · avg ${one.avgLateMin} min` : 'late'} color={colors.amber} />
                  <Stat n={one.missed} label="not held" color={colors.red} />
                </Card>
              ) : null}
              <Pressable onPress={() => setTeacherId(null)} accessibilityRole="button" style={{ marginTop: 10 }}>
                <Text variant="small" color={colors.text}>
                  ← All professors
                </Text>
              </Pressable>
              <SectionLabel>{`${r.classes.length} classes`}</SectionLabel>
              <View style={{ gap: 8 }}>
                {r.classes.map((c) => (
                  <ClassRow key={c.sessionId} c={c} tz={tz!} />
                ))}
              </View>
            </>
          )}
        </>
      ) : null}
    </Screen>
  );
}

function Stat({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={[styles.big, { color }]}>{n}</Text>
      <Text variant="small">{label}</Text>
    </View>
  );
}

function ClassRow({ c, tz }: { c: PunctualityReport['classes'][number]; tz: string }) {
  const z = zoned(c.scheduledStart, tz);
  const s = STATUS[c.status]!;
  return (
    <Pressable onPress={() => router.push({ pathname: '/session/[id]', params: { id: c.sessionId } })} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="bodyStrong">{c.courseCode}</Text>
          <Badge label={c.status === 'late' && c.lateMin ? `Late ${c.lateMin} min` : s.label} tone={s.tone} dot={false} />
          {c.substitute ? <Badge label="Cover" tone="muted" dot={false} /> : null}
        </View>
        <Text variant="small">
          {`${z.d} ${MONTHS[z.m]} · class ${clock(c.scheduledStart, tz)}${c.startedAt ? ` · started ${clock(c.startedAt, tz)}` : ''}${c.room ? ` · ${c.room}` : ''}`}
        </Text>
      </View>
      <ChevronRight color={colors.textDim} size={16} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  pct: { fontFamily: fonts.semibold, fontSize: 17 },
  summary: { flexDirection: 'row', gap: 12, marginTop: 14 },
  big: { fontFamily: fonts.bold, fontSize: 26, letterSpacing: -0.6 },
});
