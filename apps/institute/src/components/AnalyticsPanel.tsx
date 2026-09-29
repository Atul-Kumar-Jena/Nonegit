import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { router } from 'expo-router';
import type { AttendanceAnalytics } from '@attendly/protocol';
import { BandBar, HBars, Sparkline, TrendBars, weekly, type Point } from '@kit/components/Charts';
import { DownloadCard } from '@kit/components/Download';
import { Card, ErrorState, Loading, SectionLabel, Text } from '@kit/components/ui';
import { analyticsDoc } from '@kit/lib/export';
import { useApi } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { staffApi } from '@/api';
import { Chips } from '@/components/forms';
import { qk, useAnalytics, useBatches } from '@/queries';

const PERIODS = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
] as const;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function toPoints(r: AttendanceAnalytics, days: number): Point[] {
  if (days > 31)
    return weekly(r.days).map((w) => {
      const d = new Date(`${w.date}T00:00:00Z`);
      const pc = w.expected ? (w.present / w.expected) * 100 : null;
      return { key: w.key, label: `${d.getUTCDate()}/${d.getUTCMonth() + 1}`, value: pc, detail: `Week of ${d.getUTCDate()} ${MON[d.getUTCMonth()]} · ${w.present} of ${w.expected} marks` };
    });
  return r.days.map((x) => {
    const d = new Date(`${x.date}T00:00:00Z`);
    return { key: x.date, label: String(d.getUTCDate()), value: x.percent, detail: `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} · ${x.classes} ${x.classes === 1 ? 'class' : 'classes'} · ${x.present} of ${x.expected} present` };
  });
}

/**
 * Trends for the chosen batch / subject (or everything): attendance every day, how students are
 * spread around the minimum, each subject and each batch — and the daily report to download.
 */
export function AnalyticsPanel({ batchId, courseId, onBatch }: { batchId?: string; courseId?: string; onBatch?: (id: string) => void }) {
  const api = useApi();
  const [days, setDays] = useState<number>(30);
  const q = useAnalytics(days, batchId, courseId);
  const batches = useBatches();
  const r = q.data;
  const names = new Map((batches.data ?? []).map((b) => [b.id, b.name]));
  return (
    <>
      <SectionLabel right={<Chips value={days} options={PERIODS} onChange={setDays} />}>Trends</SectionLabel>
      {q.isPending ? <Loading /> : null}
      {q.isError && !r ? <ErrorState message={q.error.message} onRetry={() => void q.refetch()} /> : null}
      {r ? (
        <View style={{ gap: 12, opacity: q.isPlaceholderData ? 0.6 : 1 }}>
          <Card style={{ gap: 8 }}>
            <Text variant="label">{`${r.scope.label} · attendance ${days > 31 ? 'each week' : 'each day'}`}</Text>
            <TrendBars data={toPoints(r, days)} min={r.minPercent} title={r.total.classes ? `${r.total.classes} classes · ${r.total.percent ?? '—'}% overall` : undefined} />
          </Card>
          <Card style={{ gap: 10 }}>
            <Text variant="label">Students by attendance</Text>
            <BandBar bands={r.bands} min={r.minPercent} />
          </Card>
          {!batchId && r.batches.length ? (
            <Card style={{ gap: 10 }}>
              <Text variant="label">Batches</Text>
              <HBars rows={r.batches.map((b) => ({ key: b.batchId, label: b.name, sub: `${b.present} of ${b.expected} marks`, value: b.percent }))} min={r.minPercent} onPress={onBatch} />
            </Card>
          ) : null}
          {!courseId && r.subjects.length ? (
            <Card style={{ gap: 10 }}>
              <Text variant="label">Subjects</Text>
              <HBars
                rows={r.subjects.map((s) => ({ key: s.courseId, label: s.code, sub: `${s.classes} classes`, value: s.percent }))}
                min={r.minPercent}
                onPress={(id) => router.push({ pathname: '/course/[id]', params: { id } })}
              />
            </Card>
          ) : null}
          <DownloadCard
            title="Daily report — every day, every batch"
            hint="Each day’s attendance, each batch day by day, subjects and batches over the period"
            queryKey={qk.analytics(days, batchId, courseId)}
            fetch={() => staffApi.analytics(api, { days, batchId, courseId })}
            toDoc={(d) => analyticsDoc(d, names)}
          />
        </View>
      ) : null}
    </>
  );
}

/** Today screen: attendance over the last 7 days at a glance (tap for the full trends). */
export function AttendanceGlance() {
  const q = useAnalytics(7);
  const r = q.data;
  if (!r || r.total.classes === 0) return null;
  const today = r.days.at(-1);
  return (
    <Pressable onPress={() => router.push('/reports')} accessibilityRole="button" accessibilityLabel="Attendance this week. Open reports" style={{ marginTop: 14 }}>
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="label">{`${r.scope.mine ? 'Your classes' : 'Attendance'} · last 7 days`}</Text>
          <Text style={{ fontFamily: fonts.bold, fontSize: 28, letterSpacing: -0.8, color: r.total.percent !== null && r.total.percent < r.minPercent ? colors.amber : colors.text }}>
            {r.total.percent === null ? '—' : `${r.total.percent}%`}
          </Text>
          <Text variant="small">{`${r.total.classes} classes · last day ${today?.percent ?? '—'}% · min ${r.minPercent}%`}</Text>
        </View>
        <Sparkline values={r.days.map((d) => d.percent)} min={r.minPercent} width={110} height={44} />
        <ChevronRight color={colors.textDim} size={16} />
      </Card>
    </Pressable>
  );
}
