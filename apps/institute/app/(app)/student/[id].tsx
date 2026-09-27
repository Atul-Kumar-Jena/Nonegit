import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronDown, ChevronUp, UserRound } from 'lucide-react-native';
import type { ReportSubject } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { DownloadCard, DownloadRow } from '@kit/components/Download';
import { Badge, Button, Card, ErrorState, Loading, ProgressBar, SectionLabel, Text } from '@kit/components/ui';
import { studentReportDoc } from '@kit/lib/export';
import { clock, dayLabel, pct } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { staffApi } from '@/api';
import { Header } from '@/components/forms';
import { qk, useCan, useOverview, useStudentReport } from '@/queries';
import { CreditSheet } from '@/components/CreditSheet';
import { ymdIn } from '@/time';
import { CREDIT_REASONS } from '@attendly/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Award } from 'lucide-react-native';
import { confirmAction } from '@/components/forms';

/** Any student's attendance, subject by subject (every teacher can open this). */
export default function StudentAttendance() {
  const { id: raw } = useLocalSearchParams<{ id: string }>();
  const id = String(raw ?? '');
  const api = useApi();
  const admin = useCan('people');
  const q = useStudentReport(id);
  const [open, setOpen] = useState<string | null>(null);
  const [crediting, setCrediting] = useState(false);
  const canAll = useCan('courses');
  const tz = useOverview().data?.timezone;
  const qc = useQueryClient();
  const credits = useQuery({ queryKey: ['staff', 'credits', id], queryFn: () => staffApi.credits(api, id), enabled: !!id });

  if (q.isPending) return <Screen scroll={false}><Header title="Student" /><Loading /></Screen>;
  if (!q.data)
    return (
      <Screen>
        <Header title="Student" />
        <ErrorState message={q.error?.message ?? 'Not found.'} onRetry={() => void q.refetch()} />
      </Screen>
    );
  const r = q.data;
  const risk = r.total.standing === 'at-risk';

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header title={r.student.fullName} subtitle={[r.student.rollNo, r.student.batches.join(', ')].filter(Boolean).join(' · ') || 'Student'} info="studentReport" />

      <Card tone={risk ? 'amber' : undefined} style={{ marginTop: 14 }}>
        <Text variant="label">{`${r.termName} · overall`}</Text>
        <View style={styles.between}>
          <Text style={styles.big}>{r.total.percent === null ? '—' : `${pct(r.total.percent)}%`}</Text>
          {risk ? <Badge label={`BELOW ${pct(r.minPercent)}%`} tone="amber" /> : null}
        </View>
        <Text variant="small">{`${r.total.attended} of ${r.total.held} classes · ${r.subjects.length} subjects`}</Text>
      </Card>

      <View style={{ marginTop: 12 }}>
        <DownloadCard
          title="Download all subjects"
          hint="Per subject and cumulative"
          queryKey={qk.studentReport(id)}
          fetch={() => staffApi.studentReport(api, id)}
          toDoc={studentReportDoc}
        />
      </View>

      <SectionLabel>Per subject — tap for every class</SectionLabel>
      <View style={{ gap: 10 }}>
        {r.subjects.length === 0 ? (
          <Card>
            <Text variant="small">Not enrolled in any subject yet.</Text>
          </Card>
        ) : (
          r.subjects.map((s) => <SubjectBlock key={s.courseId} userId={id} s={s} min={r.minPercent} open={open === s.courseId} onToggle={() => setOpen(open === s.courseId ? null : s.courseId)} />)
        )}
      </View>

      <SectionLabel>Attendance credit</SectionLabel>
      <Card style={{ gap: 10 }}>
        <Text variant="small">Medical leave, a fest, sports or college duty: count missed classes as attended, with a note the student sees.</Text>
        <Button title="Give attendance credit" onPress={() => setCrediting(true)} icon={<Award color="#0a0a0a" size={16} />} />
        {(credits.data ?? []).map((c) => (
          <View key={c.id} style={[styles.credit, c.undone && { opacity: 0.5 }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="bodyStrong">{`${CREDIT_REASONS[c.reason]} · +${c.credited} ${c.credited === 1 ? 'class' : 'classes'}${c.subject ? ` · ${c.subject}` : ' · all subjects'}`}</Text>
              <Text variant="small" numberOfLines={3}>
                {`${c.note}\n${c.requested} · by ${c.by ?? '—'} · ${dayLabel(c.createdAt)}${c.undone ? ' · undone' : ''}`}
              </Text>
            </View>
            {!c.undone ? (
              <Button
                title="Undo"
                kind="ghost"
                compact
                onPress={() =>
                  confirmAction('Undo this credit?', `The ${c.credited} credited ${c.credited === 1 ? 'class goes' : 'classes go'} back to absent.`, 'Undo', () =>
                    void staffApi.undoCredit(api, c.id).then(() => qc.invalidateQueries({ queryKey: ['staff'] })),
                  true)
                }
              />
            ) : null}
          </View>
        ))}
      </Card>
      {crediting ? (
        <CreditSheet
          studentId={id}
          studentName={r.student.fullName}
          subjects={r.subjects.map((x) => ({ courseId: x.courseId, code: x.code, title: x.title }))}
          canAll={canAll}
          today={ymdIn(api.serverNow(), tz)}
          onClose={() => setCrediting(false)}
        />
      ) : null}

      {admin ? (
        <Button
          title="Profile, phone & sign-in"
          kind="secondary"
          onPress={() => router.push({ pathname: '/people/[id]', params: { id } })}
          icon={<UserRound color={colors.text} size={16} />}
          style={{ marginTop: 18 }}
        />
      ) : null}
    </Screen>
  );
}

function SubjectBlock({ userId, s, min, open, onToggle }: { userId: string; s: ReportSubject; min: number; open: boolean; onToggle: () => void }) {
  const api = useApi();
  const detail = useStudentReport(userId, s.courseId, open);
  const [all, setAll] = useState(false);
  const classes = [...(detail.data?.classes ?? [])].reverse(); // newest first
  const risk = s.standing === 'at-risk';
  const tz = detail.data?.timezone;
  return (
    <Card tone={risk ? 'amber' : undefined} style={{ gap: 10 }}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${s.code}, ${pct(s.percent)} percent`}>
        <View style={styles.between}>
          <View style={{ flex: 1 }}>
            <Text variant="monoSmall">{s.code}</Text>
            <Text variant="bodyStrong" numberOfLines={1}>
              {s.title}
            </Text>
            <Text variant="small" numberOfLines={1}>{`${s.instructor ?? 'No teacher'} · ${s.attended}/${s.held}`}</Text>
          </View>
          <Text style={[styles.pct, { color: risk ? colors.red : colors.text }]}>{s.percent === null ? '—' : `${pct(s.percent)}%`}</Text>
          {open ? <ChevronUp color={colors.textDim} size={18} /> : <ChevronDown color={colors.textDim} size={18} />}
        </View>
        <View style={{ marginTop: 10 }}>
          <ProgressBar value={s.percent} marker={min} tone={risk ? 'amber' : 'cyan'} />
        </View>
      </Pressable>
      {open ? (
        <View>
          {detail.isPending ? (
            <Loading />
          ) : !classes.length ? (
            <Text variant="small">{detail.isError ? detail.error.message : 'No classes held yet.'}</Text>
          ) : (
            (all ? classes : classes.slice(0, 12)).map((c) => (
              <View key={c.sessionId} style={styles.cls}>
                <View style={[styles.dot, { backgroundColor: c.status === 'present' ? colors.green : c.status === 'live' ? colors.text : colors.red }]} />
                <Text variant="body" style={{ flex: 1 }}>{`${dayLabel(c.start, tz)} · ${clock(c.start, tz)}`}</Text>
                <Text variant="small">{c.status === 'present' ? `Present${c.how ? ` · ${c.how}` : ''}` : c.status === 'live' ? 'In progress' : 'Absent'}</Text>
              </View>
            ))
          )}
          {classes.length > 12 && !all ? <Button title={`Show all ${classes.length} classes`} kind="ghost" compact onPress={() => setAll(true)} /> : null}
          <DownloadRow
            label={`${s.code} — every class`}
            queryKey={qk.studentReport(userId, s.courseId)}
            fetch={() => staffApi.studentReport(api, userId, s.courseId)}
            toDoc={studentReportDoc}
          />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  credit: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  between: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  big: { fontFamily: fonts.bold, fontSize: 30, letterSpacing: -1, color: colors.text, marginTop: 4, flex: 1 },
  pct: { fontFamily: fonts.semibold, fontSize: 18 },
  cls: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
