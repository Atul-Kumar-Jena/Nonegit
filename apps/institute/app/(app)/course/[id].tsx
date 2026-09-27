import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { CalendarPlus, Download, Pencil, Plus, Search, Users } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Input, Loading, Notice, ProgressBar, Segmented, Text } from '@kit/components/ui';
import { dateLong, pct } from '@kit/lib/format';
import { colors, fonts } from '@kit/theme';
import { Empty, Header, WEEKDAY_NAME } from '@/components/forms';
import { SessionCard } from '@/components/SessionCard';
import { shareCsv, toCsv } from '@/export-csv';
import { useLocalSessions, withLocal } from '@/local-sessions';
import { qk, useCourseSessions, useCan, useOverview, useReport, useTimetable } from '@/queries';
import { staffApi } from '@/api';
import { DownloadCard } from '@kit/components/Download';
import { matrixReportDoc } from '@kit/lib/export';
import { useApi } from '@kit/state/session';

type Tab = 'students' | 'classes' | 'schedule';
const TABS = [
  { value: 'students', label: 'Students' },
  { value: 'classes', label: 'Classes' },
  { value: 'schedule', label: 'Schedule' },
] as const;

/** A course: who is falling behind, every class held, and its weekly slots. */
export default function CourseDetail() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = String(rawId ?? '');
  const admin = useCan('courses');
  const api = useApi();
  const report = useReport(id);
  const sessions = useCourseSessions(id);
  const slots = useTimetable();
  const tz = useOverview().data?.timezone;
  const local = useLocalSessions();
  const [tab, setTab] = useState<Tab>('students');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'risk'>('all');
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const students = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (report.data?.students ?? [])
      .filter((x) => (filter === 'risk' ? x.standing === 'at-risk' : true))
      .filter((x) => (s ? `${x.fullName} ${x.rollNo ?? ''}`.toLowerCase().includes(s) : true));
  }, [report.data, search, filter]);
  const courseSlots = (slots.data ?? []).filter((s) => s.courseId === id);

  if (report.isPending) return <Screen scroll={false}><Header title="Course" /><Loading /></Screen>;
  if (!report.data)
    return (
      <Screen>
        <Header title="Course" />
        <ErrorState message={report.error?.message ?? 'Couldn’t load this course.'} onRetry={() => void report.refetch()} />
      </Screen>
    );

  const r = report.data;
  const c = r.course;
  const atRisk = r.students.filter((s) => s.standing === 'at-risk').length;

  async function exportCsv() {
    setExportError(null);
    setExporting(true);
    try {
      const rows: (string | number | null)[][] = [['Roll no.', 'Name', 'Attended', 'Held', 'Percent', 'Standing', `Classes in a row to reach ${r.minPercent}%`]];
      for (const s of r.students)
        rows.push([s.rollNo, s.fullName, s.attended, s.held, s.percent === null ? '' : s.percent.toFixed(1), s.standing, s.standing === 'at-risk' ? (s.needToReach >= 10_000 ? 'not reachable' : s.needToReach) : '']);
      await shareCsv(`${c.code}-attendance-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <Screen
      onRefresh={() => {
        void report.refetch();
        void sessions.refetch();
        void slots.refetch();
      }}
      refreshing={report.isRefetching}
    >
      <Header
        title={c.code}
        subtitle={c.kind === 'lab' ? 'Lab' : 'Theory'}
        right={admin ? <Button title="Edit" kind="secondary" compact onPress={() => router.push({ pathname: '/course-form', params: { id } })} icon={<Pencil color={colors.text} size={14} />} /> : undefined}
      />
      <Text variant="title" style={{ marginTop: 4 }}>
        {c.title}
      </Text>
      <Text variant="small" style={{ marginTop: 4 }}>
        {c.instructor?.name ?? 'No teacher assigned'} · {c.studentCount} students · {r.held} classes held
      </Text>
      {!c.active ? (
        <View style={{ marginTop: 10 }}>
          <Notice tone="amber" message="This course is archived." />
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button title="Extra class" kind="secondary" compact onPress={() => router.push({ pathname: '/extra-class', params: { courseId: id } })} icon={<CalendarPlus color={colors.text} size={15} />} style={{ flex: 1 }} />
        {admin ? (
          <Button title="Students" kind="secondary" compact onPress={() => router.push({ pathname: '/roster', params: { courseId: id } })} icon={<Users color={colors.text} size={15} />} style={{ flex: 1 }} />
        ) : null}
        <Button title="CSV" kind="secondary" compact onPress={() => void exportCsv()} loading={exporting} icon={<Download color={colors.text} size={15} />} style={{ flex: 1 }} />
      </View>
      {exportError ? <Notice tone="red" message={exportError} /> : null}
      <View style={{ marginTop: 12 }}>
        <DownloadCard
          title={`Download ${c.code} attendance`}
          hint="Every student: attended, held, % and status"
          queryKey={qk.matrix(undefined, id)}
          fetch={() => staffApi.matrix(api, { courseId: id })}
          toDoc={matrixReportDoc}
        />
      </View>

      <View style={{ marginTop: 16 }}>
        <Segmented value={tab} options={TABS} onChange={setTab} />
      </View>

      {tab === 'students' ? (
        <View style={{ marginTop: 14, gap: 10 }}>
          {r.students.length === 0 ? (
            <Empty
              title="No students enrolled"
              message="Students must be enrolled before they can scan or be ticked in the register."
              action={admin ? <Button title="Add students" onPress={() => router.push({ pathname: '/roster', params: { courseId: id } })} /> : undefined}
            />
          ) : (
            <>
              <View style={styles.filterRow}>
                <Pressable onPress={() => setFilter('all')} style={[styles.pill, filter === 'all' && styles.pillOn]} accessibilityRole="button">
                  <Text variant="small" color={filter === 'all' ? colors.text : undefined}>
                    All {r.students.length}
                  </Text>
                </Pressable>
                <Pressable onPress={() => setFilter('risk')} style={[styles.pill, filter === 'risk' && styles.pillOn]} accessibilityRole="button">
                  <Text variant="small" color={atRisk ? colors.amber : undefined}>
                    Below {pct(r.minPercent)}% · {atRisk}
                  </Text>
                </Pressable>
              </View>
              {r.students.length > 8 ? <Input value={search} onChangeText={setSearch} placeholder="Search name or roll no." icon={<Search color={colors.textDim} size={16} />} autoCorrect={false} /> : null}
              <Card padded={false}>
                {students.length === 0 ? (
                  <Text variant="small" style={{ padding: 16 }}>
                    No one here.
                  </Text>
                ) : (
                  students.map((s, i) => (
                    <Pressable
                      key={s.userId}
                      onPress={() => router.push({ pathname: '/student/[id]', params: { id: s.userId } })}
                      accessibilityRole="button"
                      accessibilityLabel={`${s.fullName} — attendance in every subject`}
                      style={[styles.student, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
                    >
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text variant="bodyStrong" numberOfLines={1}>
                          {s.fullName}
                        </Text>
                        <Text variant="monoSmall">
                          {s.rollNo ?? '—'} · {s.attended}/{s.held}
                          {s.standing === 'at-risk' ? (s.needToReach >= 10_000 ? ' · can’t reach min' : ` · needs ${s.needToReach} in a row`) : ''}
                        </Text>
                        <ProgressBar value={s.percent} marker={r.minPercent} tone={s.standing === 'at-risk' ? 'amber' : 'cyan'} height={4} />
                      </View>
                      <Text style={[styles.pct, { color: s.standing === 'at-risk' ? colors.amber : colors.text }]}>{pct(s.percent)}%</Text>
                    </Pressable>
                  ))
                )}
              </Card>
            </>
          )}
        </View>
      ) : null}

      {tab === 'classes' ? (
        <View style={{ marginTop: 14, gap: 10 }}>
          {sessions.isPending ? (
            <Loading />
          ) : (sessions.data ?? []).length === 0 ? (
            <Empty title="No classes yet" message="Add weekly slots under Schedule, or an extra class." />
          ) : (
            (sessions.data ?? []).map((s) => <SessionCard key={s.id} s={withLocal(s, local)} tz={tz ?? 'UTC'} showDate={dateLong(s.scheduledStart)} />)
          )}
        </View>
      ) : null}

      {tab === 'schedule' ? (
        <View style={{ marginTop: 14, gap: 10 }}>
          {courseSlots.length === 0 ? (
            <Empty title="No weekly slots" message="Weekly slots create this course’s classes automatically." />
          ) : (
            courseSlots.map((s) => (
              <Pressable key={s.id} disabled={!admin} onPress={() => router.push({ pathname: '/slot-form', params: { id: s.id } })} accessibilityRole="button">
                <Card style={[styles.slot, !s.active && { opacity: 0.55 }]}>
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong">
                      {WEEKDAY_NAME[s.weekday]} · {s.start}–{s.end}
                    </Text>
                    <Text variant="small">
                      {[s.room?.name ?? 'No room', s.mode === 'manual' ? 'Register' : `QR · ${s.rotationS}s`, s.validUntil ? `until ${s.validUntil}` : null].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  {!s.active ? <Badge label="Paused" tone="muted" dot={false} /> : null}
                </Card>
              </Pressable>
            ))
          )}
          {admin ? <Button title="Add weekly slot" kind="secondary" onPress={() => router.push({ pathname: '/slot-form', params: { courseId: id } })} icon={<Plus color={colors.text} size={16} />} /> : null}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  filterRow: { flexDirection: 'row', gap: 8 },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  pillOn: { borderColor: 'rgba(255, 255, 255, 0.5)', backgroundColor: 'rgba(255, 255, 255, 0.08)' },
  student: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  pct: { fontFamily: fonts.bold, fontSize: 18, minWidth: 56, textAlign: 'right' },
  slot: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
