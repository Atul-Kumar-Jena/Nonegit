import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { CalendarRange, ChevronRight, ClipboardList, Clock4, Plus, QrCode, UserPlus } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Loading, SectionLabel, Text } from '@kit/components/ui';
import { dayLabel } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts, radius } from '@kit/theme';
import { Empty, WEEKDAYS } from '@/components/forms';
import { SessionCard } from '@/components/SessionCard';
import { useLocalSessions, withLocal } from '@/local-sessions';
import { useIsAdmin, useOverview, useSessionsOn, useTimetable } from '@/queries';
import { ymdIn } from '@/time';

/** The weekly timetable (admins edit it) and the next 7 days of classes it produced. */
export default function Timetable() {
  const api = useApi();
  const admin = useIsAdmin();
  const q = useTimetable();
  const overview = useOverview();
  const tz = overview.data?.timezone;
  const week = useSessionsOn(ymdIn(api.serverNow(), tz), 7);
  const local = useLocalSessions();
  const [day, setDay] = useState(() => new Date().getDay());

  const byDay = useMemo(() => {
    const m = new Map<number, NonNullable<typeof q.data>>();
    for (const s of q.data ?? []) m.set(s.weekday, [...(m.get(s.weekday) ?? []), s]);
    for (const list of m.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return m;
  }, [q.data]);

  const upcoming = useMemo(() => {
    const groups: { label: string; items: NonNullable<typeof week.data> }[] = [];
    for (const s of week.data ?? []) {
      const label = dayLabel(s.scheduledStart, tz);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(s);
      else groups.push({ label, items: [s] });
    }
    return groups;
  }, [week.data, tz]);

  if (q.isPending) return <Screen scroll={false}><Loading /></Screen>;
  if (q.isError && !q.data)
    return (
      <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
        <View style={{ marginTop: 40 }}>
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        </View>
      </Screen>
    );

  const slots = byDay.get(day) ?? [];
  return (
    <Screen
      onRefresh={() => {
        void q.refetch();
        void week.refetch();
      }}
      refreshing={q.isRefetching}
    >
      <Text variant="label" style={{ marginTop: 4 }}>
        Weekly
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text variant="title" style={{ flex: 1, marginTop: 4 }}>
          Timetable
        </Text>
        {admin ? <Button title="Add slot" compact kind="secondary" onPress={() => router.push({ pathname: '/slot-form', params: { weekday: String(day) } })} icon={<Plus color={colors.text} size={16} />} /> : null}
      </View>
      <Text variant="small" style={{ marginTop: 4 }}>
        {admin ? 'Slots repeat every week and create classes 14 days ahead — for every teacher and student app.' : 'Your weekly classes. Ask an admin to change a slot.'}
      </Text>

      {admin ? (
        <Button title="Open the planner (drag & drop)" onPress={() => router.push('/planner')} icon={<CalendarRange color="#03141c" size={16} />} style={{ marginTop: 12 }} />
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
        <Button title="Who’s busy where" kind="ghost" compact onPress={() => router.push('/busy')} icon={<Clock4 color={colors.text} size={14} />} />
        {admin ? <Button title="Cover a class (drag a free teacher)" kind="ghost" compact onPress={() => router.push('/cover')} icon={<UserPlus color={colors.text} size={14} />} /> : null}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.days} style={{ marginTop: 16, marginHorizontal: -20 }}>
        {WEEKDAYS.map(({ value: d, label }) => {
          const on = d === day;
          const count = byDay.get(d)?.length ?? 0;
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
          <Empty title="Nothing on this day" message={admin ? 'Tap “Add slot” to schedule a weekly class.' : undefined} />
        ) : (
          slots.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => (admin ? router.push({ pathname: '/slot-form', params: { id: s.id } }) : router.push({ pathname: '/course/[id]', params: { id: s.courseId } }))}
              accessibilityRole="button"
            >
              <Card style={[styles.row, !s.active && { opacity: 0.5 }]}>
                <View style={{ width: 52 }}>
                  <Text style={styles.time}>{s.start}</Text>
                  <Text variant="monoSmall">{s.end}</Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                    <Text variant="monoSmall">{s.courseCode}</Text>
                    {s.mode === 'manual' ? <ClipboardList color={colors.violet} size={12} /> : <QrCode color={colors.textDim} size={12} />}
                    {!s.active ? <Badge label="Paused" tone="muted" dot={false} /> : null}
                  </View>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {s.courseTitle}
                  </Text>
                  <Text variant="small" numberOfLines={1}>
                    {[s.room?.name ?? 'No room', s.instructor].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <ChevronRight color={colors.textDim} size={18} />
              </Card>
            </Pressable>
          ))
        )}
      </View>

      <SectionLabel>Next 7 days</SectionLabel>
      {week.isPending ? (
        <Loading />
      ) : upcoming.length === 0 ? (
        <Empty title="No classes in the next 7 days" />
      ) : (
        <View style={{ gap: 14 }}>
          {upcoming.map((g) => (
            <View key={g.label} style={{ gap: 8 }}>
              <Text variant="label">{g.label}</Text>
              {g.items.map((s) => (
                <SessionCard key={s.id} s={withLocal(s, local)} tz={tz ?? 'UTC'} />
              ))}
            </View>
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  days: { paddingHorizontal: 20, gap: 8 },
  day: { width: 54, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, alignItems: 'center', gap: 2 },
  dayOn: { borderColor: 'rgba(34,211,238,0.5)', backgroundColor: 'rgba(34,211,238,0.08)' },
  dayText: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
  dayCount: { fontFamily: fonts.mono, fontSize: 11, color: colors.textDim },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  time: { fontFamily: fonts.monoMedium, fontSize: 14, color: colors.text },
});
