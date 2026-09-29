import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { CalendarPlus } from 'lucide-react-native';
import type { BusyBlock } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Avatar, Badge, Button, Card, ErrorState, Loading, Segmented, Text } from '@kit/components/ui';
import { initials } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { DateField, Header, TimeField, fromMinutes, hm12, toMinutes } from '@/components/forms';
import { useAvailability, useOverview } from '@/queries';
import { ymdIn } from '@/time';

const DAY_START = 7 * 60;
const DAY_END = 20 * 60;

/** Who is teaching where, all day — and who is free when you need a substitute. */
export default function Busy() {
  const api = useApi();
  const tz = useOverview().data?.timezone;
  const [date, setDate] = useState(() => ymdIn(api.serverNow(), tz));
  const [view, setView] = useState<'teachers' | 'rooms'>('teachers');
  const [freeOnly, setFreeOnly] = useState(false);
  // Default to the next 5 minutes from now: "who's free right now" is the usual question.
  const [at, setAt] = useState(() => fromMinutes(Math.min(Math.ceil(toMinutes(new Date().toTimeString().slice(0, 5)) / 5) * 5, 23 * 60 + 55)));
  const q = useAvailability(date);
  const [width, setWidth] = useState(0);

  const all = useMemo(() => {
    const list = view === 'teachers' ? (q.data?.teachers ?? []) : (q.data?.rooms ?? []);
    const t = toMinutes(at);
    return list
      .map((r) => {
        const sorted = [...r.busy].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
        const now = sorted.find((b) => toMinutes(b.start) <= t && t < toMinutes(b.end));
        const next = sorted.find((b) => toMinutes(b.start) > t);
        const prev = [...sorted].reverse().find((b) => toMinutes(b.end) <= t);
        // The free window around the chosen time (for scheduling from here).
        const freeFrom = now ? null : prev ? prev.end : null;
        const freeUntil = now ? null : next ? next.start : null;
        return { ...r, busy: sorted, now, next, freeFrom, freeUntil };
      })
      .sort((a, b) => Number(!!a.now) - Number(!!b.now) || a.name.localeCompare(b.name));
  }, [q.data, view, at]);
  const freeCount = all.filter((r) => !r.now).length;
  const rows = all.filter((r) => !freeOnly || !r.now);
  const nowHm = fromMinutes(Math.round(toMinutes(new Date().toTimeString().slice(0, 5)) / 5) * 5);
  const status = (r: (typeof all)[number]) =>
    r.now
      ? `${view === 'teachers' ? 'Teaching' : 'In use:'} ${r.now.courseCode}${view === 'teachers' && r.now.room ? ` in ${r.now.room}` : ''} until ${hm12(r.now.end)}`
      : r.next
        ? `Free until ${hm12(r.next.start)} (then ${r.next.courseCode})`
        : r.busy.length
          ? 'Free for the rest of the day'
          : 'Free all day';

  const x = (hm: string) => ((Math.min(Math.max(toMinutes(hm), DAY_START), DAY_END) - DAY_START) / (DAY_END - DAY_START)) * width;
  const hours = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START / 60 + i);

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header info="busy" title="Who’s free" />
      <DateField value={date} onChange={setDate} />
      <View style={{ marginTop: 12 }}>
        <Segmented value={view} options={[{ value: 'teachers', label: 'Teachers' }, { value: 'rooms', label: 'Rooms' }]} onChange={setView} />
      </View>
      <Card style={{ marginTop: 12, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="label">Check a time</Text>
          <Button title="Now" kind="secondary" compact onPress={() => setAt(nowHm)} />
        </View>
        <TimeField label="Check time" value={at} onChange={setAt} />
      </Card>
      {q.data ? (
        <View style={styles.stats}>
          <Pressable onPress={() => setFreeOnly(true)} accessibilityRole="button" style={[styles.stat, freeOnly && styles.statOn]}>
            <Text style={[styles.statN, { color: colors.green }]}>{freeCount}</Text>
            <Text variant="small">{`free at ${hm12(at)}`}</Text>
          </Pressable>
          <Pressable onPress={() => setFreeOnly(false)} accessibilityRole="button" style={[styles.stat, !freeOnly && styles.statOn]}>
            <Text style={styles.statN}>{all.length}</Text>
            <Text variant="small">{view === 'teachers' ? 'teachers in all' : 'rooms in all'}</Text>
          </Pressable>
        </View>
      ) : null}

      {q.isPending ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <View style={{ marginTop: 14, gap: 10 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width - 28)}>
          <View style={[styles.axis, { marginLeft: 14, width }]}>
            {hours.map((h) => (
              <Text key={h} style={[styles.hour, { left: x(`${String(h).padStart(2, '0')}:00`) - 11 }]}>
                {`${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`}
              </Text>
            ))}
          </View>
          {rows.length === 0 ? (
            <Text variant="small">{freeOnly ? `No one is free at ${hm12(at)}.` : 'Nothing here.'}</Text>
          ) : (
            rows.map((r) => (
              <Card key={r.id} style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Avatar text={initials(r.name) || '?'} size={38} />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong" style={{ fontSize: 16 }} numberOfLines={1}>
                      {r.name}
                    </Text>
                    <Text variant="small" color={r.now ? colors.amber : colors.green} numberOfLines={2}>
                      {status(r)}
                    </Text>
                  </View>
                  {r.now ? <Badge label="Busy" tone="amber" dot={false} /> : <Badge label="Free" tone="green" dot={false} />}
                </View>
                {!r.now ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Text variant="small" style={{ flex: 1 }}>
                      {`Free ${r.freeFrom ? `from ${hm12(r.freeFrom)}` : 'from the morning'} ${r.freeUntil ? `until ${hm12(r.freeUntil)}` : 'for the rest of the day'}`}
                    </Text>
                    <Button
                      title={view === 'teachers' ? 'Schedule a class' : 'Book for a class'}
                      compact
                      icon={<CalendarPlus color={colors.bg} size={14} />}
                      onPress={() => {
                        const s = toMinutes(at);
                        const until = r.freeUntil ? toMinutes(r.freeUntil) : 23 * 60 + 55;
                        const e = Math.min(s + 60, until);
                        router.push({
                          pathname: '/extra-class',
                          params: {
                            date,
                            start: at,
                            end: fromMinutes(e > s ? e : Math.min(s + 30, 23 * 60 + 55)),
                            ...(view === 'teachers' ? { teacherId: r.id, teacherName: r.name } : { roomId: r.id }),
                          },
                        });
                      }}
                    />
                  </View>
                ) : null}
                <View style={[styles.track, { width }]}>
                  <View style={[styles.cursor, { left: x(at) }]} />
                  {r.busy.map((b) => (
                    <Pressable
                      key={b.sessionId}
                      onPress={() => router.push({ pathname: '/session/[id]', params: { id: b.sessionId } })}
                      accessibilityRole="button"
                      accessibilityLabel={`${b.courseCode} ${b.start} to ${b.end}${b.room ? ` in ${b.room}` : ''}`}
                      style={[styles.block, { left: x(b.start), width: Math.max(6, x(b.end) - x(b.start)) }, b.substitute && { backgroundColor: 'rgba(255, 255, 255, 0.55)' }]}
                    >
                      <Text style={styles.blockText} numberOfLines={1}>
                        {b.courseCode}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {r.busy.length ? (
                  <Text variant="small" numberOfLines={3}>
                    {r.busy.map((b) => `${hm12(b.start)}–${hm12(b.end)} ${b.courseCode}${view === 'teachers' ? (b.room ? ` (${b.room})` : '') : ''}${b.substitute ? ' · cover' : ''}`).join('   ·   ')}
                  </Text>
                ) : null}
              </Card>
            ))
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  axis: { height: 16 },
  hour: { position: 'absolute', width: 22, textAlign: 'center', fontFamily: fonts.mono, fontSize: 10, color: colors.textDim },
  stats: { flexDirection: 'row', gap: 10, marginTop: 12 },
  stat: { flex: 1, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, gap: 2 },
  statOn: { borderColor: colors.text },
  statN: { fontFamily: fonts.bold, fontSize: 26, color: colors.text },
  track: { height: 30, borderRadius: 8, backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  block: { position: 'absolute', top: 2, bottom: 2, borderRadius: 6, backgroundColor: 'rgba(255, 255, 255, 0.55)', justifyContent: 'center', paddingHorizontal: 4 },
  blockText: { fontFamily: fonts.semibold, fontSize: 10.5, color: '#0a0a0a' },
  cursor: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: colors.amber },
});
