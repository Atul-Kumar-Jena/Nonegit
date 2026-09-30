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
import { Chips, DateField, Select } from '@/components/forms';
import { qk, useAnalytics, useBatches, useCan, useColleagues, useOverview } from '@/queries';
import { ymdIn } from '@/time';
import type { AnalyticsFilter } from '@/api';

type PeriodKey = '7' | '30' | 'month' | 'lastmonth' | 'quarter' | 'custom';
const PERIODS: readonly { value: PeriodKey; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: 'month', label: 'This month' },
  { value: 'lastmonth', label: 'Last month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'custom', label: 'From – to' },
];
const ymd = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The chosen period as a filter: the last N days, or a from–to range in the institution's calendar. */
function periodFilter(p: PeriodKey, today: string, custom: { from: string; to: string }): { days?: number; from?: string; to?: string; span: number } {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1];
  const span = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) + 1;
  switch (p) {
    case '7':
      return { days: 7, span: 7 };
    case '30':
      return { days: 30, span: 30 };
    case 'month':
      return { from: ymd(y, m, 1), to: today, span: span(ymd(y, m, 1), today) };
    case 'lastmonth': {
      const ly = m === 0 ? y - 1 : y;
      const lm = (m + 11) % 12;
      const last = new Date(Date.UTC(ly, lm + 1, 0)).getUTCDate();
      return { from: ymd(ly, lm, 1), to: ymd(ly, lm, last), span: last };
    }
    case 'quarter': {
      const qm = Math.floor(m / 3) * 3;
      return { from: ymd(y, qm, 1), to: today, span: span(ymd(y, qm, 1), today) };
    }
    default:
      return { from: custom.from, to: custom.to, span: span(custom.from, custom.to) };
  }
}
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
  const tz = useOverview().data?.timezone;
  const today = ymdIn(api.serverNow(), tz);
  const canCourses = useCan('courses');
  const canPlanner = useCan('planner');
  const everyone = canCourses || canPlanner;
  const colleagues = useColleagues(everyone);
  const [period, setPeriod] = useState<PeriodKey>('30');
  const [custom, setCustom] = useState({ from: `${today.slice(0, 8)}01`, to: today });
  const [teacherId, setTeacherId] = useState<string | null>(null);
  const pf = periodFilter(period, today, custom);
  const days = pf.span;
  const filter: AnalyticsFilter = { days: pf.days, from: pf.from, to: pf.to, batchId, courseId, teacherId: teacherId ?? undefined };
  const q = useAnalytics(filter);
  const batches = useBatches();
  const r = q.data;
  const names = new Map((batches.data ?? []).map((b) => [b.id, b.name]));
  return (
    <>
      <SectionLabel>Period</SectionLabel>
      <Chips value={period} options={PERIODS} onChange={setPeriod} />
      {period === 'custom' ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <View style={{ flex: 1 }}>
            <Text variant="small">From</Text>
            <DateField value={custom.from} onChange={(v) => setCustom((c) => ({ ...c, from: v }))} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="small">To</Text>
            <DateField value={custom.to} onChange={(v) => setCustom((c) => ({ ...c, to: v }))} />
          </View>
        </View>
      ) : null}
      {everyone ? (
        <View style={{ marginTop: 10 }}>
          <Select
            title="Professor"
            value={teacherId}
            onChange={setTeacherId}
            allowNone="All professors"
            placeholder="All professors"
            options={(colleagues.data ?? []).map((c) => ({ value: c.id, label: c.name, sub: c.role === 'admin' ? 'Admin' : 'Professor' }))}
          />
        </View>
      ) : null}
      {custom.from > custom.to && period === 'custom' ? <Text variant="small" color={colors.red}>The start date must be before the end date.</Text> : null}
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
          {!teacherId && r.teachers.length > 1 ? (
            <Card style={{ gap: 10 }}>
              <Text variant="label">Professors · students attending their classes</Text>
              <HBars rows={r.teachers.map((t) => ({ key: t.teacherId, label: t.name, sub: `${t.classes} classes · ${t.present} of ${t.expected}`, value: t.percent }))} min={r.minPercent} onPress={setTeacherId} />
            </Card>
          ) : null}
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
            title={`Print / download · ${r.scope.label}`}
            hint="PDF to print or Excel: every day, every batch day by day, professors, subjects, and students by attendance — for the period above"
            queryKey={qk.analytics(filter)}
            fetch={() => staffApi.analytics(api, filter)}
            toDoc={(d) => analyticsDoc(d, names)}
          />
        </View>
      ) : null}
    </>
  );
}

/** Today screen: attendance over the last 7 days at a glance (tap for the full trends). */
export function AttendanceGlance() {
  const q = useAnalytics({ days: 7 });
  const r = q.data;
  if (!r || r.total.classes === 0) return null;
  const today = r.days.at(-1);
  return (
    <Pressable onPress={() => router.push({ pathname: '/reports', params: { view: 'trends' } })} accessibilityRole="button" accessibilityLabel="Attendance this week. Open reports" style={{ marginTop: 14 }}>
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
