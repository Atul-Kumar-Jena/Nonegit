import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, ClipboardList, MapPin } from 'lucide-react-native';
import type { StudentSlot, UpcomingSession } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Card, ErrorState, Loading, SectionLabel, Text } from '@kit/components/ui';
import { dayLabel, timeRange, zoned } from '@kit/lib/format';
import { colors, fonts, radius } from '@kit/theme';
import { useTimetable } from '@/state/queries';

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
      <Text variant="title" style={{ marginTop: 4 }}>
        Timetable
      </Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.days} style={{ marginTop: 16, marginHorizontal: -20 }}>
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
                <Pressable key={u.sessionId} onPress={() => router.push({ pathname: '/subject/[id]', params: { id: u.courseId } })} accessibilityRole="button">
                  <Card style={[styles.row, u.status === 'cancelled' && { opacity: 0.55 }]}>
                    <View style={styles.time}>
                      <Text style={styles.timeText}>{zoned(u.scheduledStart, q.data!.timezone).hm}</Text>
                    </View>
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
                    </View>
                    <StatusBadge u={u} />
                  </Card>
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      )}
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
  days: { paddingHorizontal: 20, gap: 8 },
  day: { width: 54, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: 'center', gap: 2 },
  dayOn: { borderColor: 'rgba(34,211,238,0.5)', backgroundColor: 'rgba(34,211,238,0.08)' },
  dayText: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
  dayCount: { fontFamily: fonts.mono, fontSize: 11, color: colors.textDim },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  time: { width: 50 },
  timeText: { fontFamily: fonts.monoMedium, fontSize: 14, color: colors.text },
});
