import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, ClipboardList, MapPin, MessageSquareText } from 'lucide-react-native';
import type { StudentSlot, UpcomingSession } from '@attendly/protocol';
import { NotificationBell } from '@kit/components/NotificationBell';
import { Screen } from '@kit/components/Screen';
import { Badge, Card, ErrorState, Loading, SectionLabel, Text } from '@kit/components/ui';
import { dayLabel, timeRange, zoned, clock } from '@kit/lib/format';
import { colors, fonts, radius } from '@kit/theme';
import { ChangeNote } from '@/components/ChangeNote';
import { AskTeacherSheet } from '@/components/AskTeacher';
import { useMyRequests, useTimetable } from '@/state/queries';

const DAYS = [
  { d: 1, label: 'Mon' },
  { d: 2, label: 'Tue' },
  { d: 3, label: 'Wed' },
  { d: 4, label: 'Thu' },
  { d: 5, label: 'Fri' },
  { d: 6, label: 'Sat' },
  { d: 0, label: 'Sun' },
];

/** Weekly timetable + what's coming up this week, synced from the institution. */
export default function Timetable() {
  const q = useTimetable();
  const [day, setDay] = useState(() => new Date().getDay());
  const [ask, setAsk] = useState<UpcomingSession | null>(null);
  const requests = useMyRequests();
  const waiting = (requests.data?.outgoing ?? []).filter((r) => r.status === 'pending').length;
  const answered = (requests.data?.outgoing ?? []).filter((r) => r.status === 'accepted' || r.status === 'declined').length;

  const bySlotDay = useMemo(() => {
    const m = new Map<number, StudentSlot[]>();
    for (const s of q.data?.slots ?? []) m.set(s.weekday, [...(m.get(s.weekday) ?? []), s]);
    return m;
  }, [q.data]);

  const upcomingByDay = useMemo(() => {
    const groups: { key: string; label: string; items: UpcomingSession[] }[] = [];
    for (const u of q.data?.upcoming ?? []) {
      const label = dayLabel(u.scheduledStart, q.data?.timezone);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(u);
      else groups.push({ key: u.sessionId, label, items: [u] });
    }
    return groups;
  }, [q.data]);

  if (q.isPending) return <Screen scroll={false}><Loading /></Screen>;
  if (q.isError && !q.data)
    return (
      <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
        <View style={{ marginTop: 40 }}>
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        </View>
      </Screen>
    );

  const slots = bySlotDay.get(day) ?? [];
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Text variant="label" style={{ marginTop: 4 }}>
        Weekly
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text variant="title" style={{ marginTop: 4, flex: 1 }}>
          Timetable
        </Text>
        <NotificationBell />
      </View>
      <Text variant="small" style={{ marginTop: 4 }}>
        Always up to date: moved, cancelled and extra classes appear here the moment they’re published.
      </Text>
      <Pressable onPress={() => router.push('/requests')} accessibilityRole="button" style={styles.requests}>
        <MessageSquareText color={waiting ? colors.amber : colors.textDim} size={15} />
        <Text variant="small" style={{ flex: 1 }}>
          {waiting ? `${waiting} request${waiting === 1 ? '' : 's'} waiting for a reply` : answered ? 'My requests · see replies' : 'Ask a teacher to move a class or hold an extra one'}
        </Text>
        <ChevronRight color={colors.textDim} size={16} />
      </Pressable>

      <ScrollView horizontal showsHorizontalScrollIndicator persistentScrollbar indicatorStyle="white" contentContainerStyle={styles.days} style={{ marginTop: 16, marginHorizontal: -20 }}>
        {DAYS.map(({ d, label }) => {
          const on = d === day;
          const count = bySlotDay.get(d)?.length ?? 0;
          return (
            <Pressable key={d} onPress={() => setDay(d)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={[styles.day, on && styles.dayOn]}>
              <Text style={[styles.dayText, on && { color: colors.text }]}>{label}</Text>
              <Text style={[styles.dayCount, on && { color: colors.cyan }]}>{count || '–'}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={{ gap: 10, marginTop: 14 }}>
        {slots.length === 0 ? (
          <Card>
            <Text variant="small">No classes on this day.</Text>
          </Card>
        ) : (
          slots.map((s, i) => (
            <Pressable key={`${s.courseId}-${i}`} onPress={() => router.push({ pathname: '/subject/[id]', params: { id: s.courseId } })} accessibilityRole="button">
              <Card style={styles.row}>
                <View style={styles.time}>
                  <Text style={styles.timeText}>{s.start}</Text>
                  <Text variant="monoSmall">{s.end}</Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                    <Text variant="monoSmall">{s.courseCode}</Text>
                    {s.mode === 'manual' ? <Badge label="Paper register" tone="violet" dot={false} /> : null}
                  </View>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {s.courseTitle}
                  </Text>
                  <Text variant="small" numberOfLines={1}>
                    {[s.room, s.instructor].filter(Boolean).join(' · ') || 'Room to be announced'}
                  </Text>
                </View>
                <ChevronRight color={colors.textDim} size={18} />
              </Card>
            </Pressable>
          ))
        )}
      </View>

      <SectionLabel>Next 7 days</SectionLabel>
      {upcomingByDay.length === 0 ? (
        <Card>
          <Text variant="small">Nothing scheduled in the next 7 days.</Text>
        </Card>
      ) : (
        <View style={{ gap: 14 }}>
          {upcomingByDay.map((g) => (
            <View key={g.key} style={{ gap: 8 }}>
              <Text variant="label">{g.label}</Text>
              {g.items.map((u) => (
                <Card key={u.sessionId} style={[styles.row, u.status === 'cancelled' && { opacity: 0.55 }]}>
                  <Pressable
                    onPress={() => router.push({ pathname: '/subject/[id]', params: { id: u.courseId } })}
                    accessibilityRole="button"
                    accessibilityLabel={`${u.courseCode} ${clock(u.scheduledStart, q.data!.timezone)}: open subject`}
                    style={styles.rowMain}
                  >
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="bodyStrong" numberOfLines={1}>
                        {u.courseCode} · {u.courseTitle}
                      </Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        {u.mode === 'manual' ? <ClipboardList color={colors.textDim} size={12} /> : <MapPin color={colors.textDim} size={12} />}
                        <Text variant="small" numberOfLines={1}>
                          {timeRange(u.scheduledStart, u.scheduledEnd, q.data!.timezone)}
                          {u.room ? ` · ${u.room}` : ''}
                        </Text>
                      </View>
                      <ChangeNote change={u.change} tz={q.data!.timezone} />
                    </View>
                  </Pressable>
                  <View style={{ alignItems: 'flex-end', gap: 6 }}>
                    <StatusBadge u={u} />
                    {u.status === 'scheduled' && !u.marked ? (
                      <Pressable onPress={() => setAsk(u)} accessibilityRole="button" accessibilityLabel={`Ask the teacher about ${u.courseCode}`} hitSlop={8} style={styles.ask}>
                        <MessageSquareText color={colors.cyan} size={12} />
                        <Text variant="small" color={colors.cyan}>
                          Ask
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </Card>
              ))}
            </View>
          ))}
        </View>
      )}
      {ask ? (
        <AskTeacherSheet
          session={{
            sessionId: ask.sessionId,
            courseCode: ask.courseCode,
            courseTitle: ask.courseTitle,
            when: `${dayLabel(ask.scheduledStart, q.data!.timezone)} ${timeRange(ask.scheduledStart, ask.scheduledEnd, q.data!.timezone)}`,
            teacher: ask.change?.teacher ?? null,
          }}
          onClose={() => setAsk(null)}
        />
      ) : null}
    </Screen>
  );
}

function StatusBadge({ u }: { u: UpcomingSession }) {
  if (u.marked) return <Badge label="Present" tone="green" />;
  if (u.status === 'live') return <Badge label="LIVE" tone="cyan" />;
  if (u.status === 'cancelled') return <Badge label="Cancelled" tone="red" dot={false} />;
  if (u.status === 'closed') return <Badge label="Missed" tone="amber" dot={false} />;
  return <Badge label="Upcoming" tone="muted" dot={false} />;
}

const styles = StyleSheet.create({
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  requests: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  ask: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.cyanLine },
  days: { paddingHorizontal: 20, gap: 8 },
  day: { width: 54, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: 'center', gap: 2 },
  dayOn: { borderColor: 'rgba(255, 255, 255, 0.5)', backgroundColor: 'rgba(255, 255, 255, 0.08)' },
  dayText: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
  dayCount: { fontFamily: fonts.mono, fontSize: 11, color: colors.textDim },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  time: { width: 72 },
  timeText: { fontFamily: fonts.monoMedium, fontSize: 13, color: colors.text },
});
