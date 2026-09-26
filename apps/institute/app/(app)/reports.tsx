import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronRight, Search } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { DownloadCard } from '@kit/components/Download';
import { Button, Card, ErrorState, Input, Loading, SectionLabel, Text } from '@kit/components/ui';
import { matrixReportDoc } from '@kit/lib/export';
import { pct } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts, radius } from '@kit/theme';
import { staffApi } from '@/api';
import { Chips, Header } from '@/components/forms';
import { qk, useBatches, useMatrix } from '@/queries';

const PAGE = 150;

/**
 * Attendance reports: pick a batch, then a subject (or all), see every student's %,
 * open any student, and download the view as PDF or Excel.
 */
export default function Reports() {
  const params = useLocalSearchParams<{ batchId?: string; courseId?: string }>();
  const api = useApi();
  const batches = useBatches();
  const [batch, setBatch] = useState(String(params.batchId ?? ''));
  const [course, setCourse] = useState(String(params.courseId ?? ''));
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'roll' | 'low'>('roll');
  const [limit, setLimit] = useState(PAGE);

  const base = useMatrix(batch || undefined);
  const scoped = useMatrix(batch || undefined, course || undefined);
  const q = course ? scoped : base;
  const r = q.data;

  const courseOptions = useMemo(() => [{ value: '', label: 'All subjects' }, ...(base.data?.courses ?? []).map((c) => ({ value: c.courseId, label: c.code }))], [base.data]);
  const batchOptions = useMemo(
    () => [{ value: '', label: 'All students' }, ...(batches.data ?? []).filter((b) => b.active || b.id === batch).map((b) => ({ value: b.id, label: b.name }))],
    [batches.data, batch],
  );

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = (r?.students ?? []).filter((x) => (s ? `${x.fullName} ${x.rollNo ?? ''}`.toLowerCase().includes(s) : true));
    if (sort === 'low') list.sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101));
    return list;
  }, [r, search, sort]);

  const below = r?.students.filter((s) => s.standing === 'at-risk').length ?? 0;
  const totals = r?.students.reduce((t, s) => ({ a: t.a + s.attended, h: t.h + s.held }), { a: 0, h: 0 });
  const avg = totals && totals.h ? Math.round((totals.a / totals.h) * 1000) / 10 : null;
  const stale = q.isPlaceholderData || (q.isFetching && !q.isRefetching);

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching} keyboard>
      <Header title="Attendance reports" info="reports" />

      <SectionLabel>1 · Batch</SectionLabel>
      <Chips
        value={batch}
        options={batchOptions}
        onChange={(v) => {
          setBatch(v);
          setCourse('');
          setLimit(PAGE);
        }}
      />

      <SectionLabel>2 · Subject</SectionLabel>
      {base.isPending ? (
        <Loading />
      ) : (
        <Chips
          value={course}
          options={courseOptions}
          onChange={(v) => {
            setCourse(v);
            setLimit(PAGE);
          }}
        />
      )}

      {q.isError && !r ? (
        <View style={{ marginTop: 16 }}>
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        </View>
      ) : null}

      {r ? (
        <>
          <Card style={[styles.summary, stale && { opacity: 0.6 }]}>
            <View style={{ flex: 1 }}>
              <Text variant="label">{r.scope.label}</Text>
              <Text style={styles.big}>{avg === null ? '—' : `${pct(avg)}%`}</Text>
              <Text variant="small">{`average · ${r.students.length} students · ${r.courses.length} ${r.courses.length === 1 ? 'subject' : 'subjects'}`}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[styles.big, { color: below ? colors.red : colors.text }]}>{below}</Text>
              <Text variant="small">{`below ${pct(r.minPercent)}%`}</Text>
            </View>
          </Card>

          <View style={{ marginTop: 12 }}>
            <DownloadCard
              title="Download this view"
              hint={course ? 'Each student’s classes attended, held and % in this subject' : 'Each student’s % in every subject, plus their cumulative total'}
              queryKey={qk.matrix(batch || undefined, course || undefined)}
              fetch={() => staffApi.matrix(api, { batchId: batch || undefined, courseId: course || undefined })}
              toDoc={matrixReportDoc}
            />
          </View>

          <SectionLabel right={<Chips value={sort} options={[{ value: 'roll', label: 'Roll no.' }, { value: 'low', label: 'Lowest %' }]} onChange={setSort} />}>
            3 · Students
          </SectionLabel>
          <Input value={search} onChangeText={setSearch} placeholder="Search name or roll no." icon={<Search color={colors.textDim} size={16} />} autoCorrect={false} autoCapitalize="none" />
          <View style={{ gap: 6, marginTop: 10 }}>
            {rows.length === 0 ? (
              <Text variant="small" style={{ padding: 12 }}>
                {r.students.length ? 'No one matches.' : 'No students here yet.'}
              </Text>
            ) : (
              rows.slice(0, limit).map((s) => (
                <Pressable
                  key={s.userId}
                  onPress={() => router.push({ pathname: '/student/[id]', params: { id: s.userId } })}
                  accessibilityRole="button"
                  accessibilityLabel={`${s.fullName}, ${pct(s.percent)} percent. Open`}
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong" numberOfLines={1}>
                      {s.fullName}
                    </Text>
                    <Text variant="monoSmall">{`${s.rollNo ?? 'no roll no.'} · ${s.attended}/${s.held}`}</Text>
                  </View>
                  <Text style={[styles.pct, { color: s.standing === 'at-risk' ? colors.red : s.standing === 'no-data' ? colors.textDim : colors.text }]}>
                    {s.percent === null ? '—' : `${pct(s.percent)}%`}
                  </Text>
                  <ChevronRight color={colors.textDim} size={16} />
                </Pressable>
              ))
            )}
            {rows.length > limit ? <Button title={`Show ${Math.min(PAGE, rows.length - limit)} more`} kind="secondary" compact onPress={() => setLimit(limit + PAGE)} /> : null}
          </View>
        </>
      ) : q.isPending ? (
        <Loading />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 18 },
  big: { fontFamily: fonts.bold, fontSize: 28, letterSpacing: -0.8, color: colors.text, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  pct: { fontFamily: fonts.semibold, fontSize: 17 },
});
