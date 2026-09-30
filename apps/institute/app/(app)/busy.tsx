import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { CalendarPlus, Clock3, DoorOpen, UserRound } from 'lucide-react-native';
import type { BusyBlock } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Avatar, Button, Card, ErrorState, Loading, SectionLabel, Segmented, Text } from '@kit/components/ui';
import { initials, zoned } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { DayPicker, Header, TimeField, fromMinutes, hm12, toMinutes } from '@/components/forms';
import { useAvailability, useOverview } from '@/queries';
import { ymdIn } from '@/time';

const DAY_START = 8 * 60;
const DAY_END = 18 * 60;

type Row = { id: string; name: string; busy: BusyBlock[]; now?: BusyBlock; next?: BusyBlock; freeFrom: string | null; freeUntil: string | null };

/** Who is free (and who is teaching where) at any time of the week — and one tap to schedule them. */
export default function Busy() {
  const api = useApi();
  const tz = useOverview().data?.timezone;
  const today = ymdIn(api.serverNow(), tz);
  // The institution's clock, not the phone's.
  const nowHm = () => fromMinutes(Math.min(Math.ceil(toMinutes(zoned(api.serverNow(), tz).hm) / 5) * 5, 23 * 60 + 55));
  const [date, setDate] = useState(today);
  const [view, setView] = useState<'teachers' | 'rooms'>('teachers');
  const [at, setAt] = useState(nowHm);
  const q = useAvailability(date);

  const rows = useMemo(() => {
    const list = view === 'teachers' ? (q.data?.teachers ?? []) : (q.data?.rooms ?? []);
    const t = toMinutes(at);
    return list.map((r): Row => {
      const sorted = r.busy.filter((b) => b.date === date && b.status !== 'cancelled').sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
      const now = sorted.find((b) => toMinutes(b.start) <= t && t < toMinutes(b.end));
      const next = sorted.find((b) => toMinutes(b.start) > t);
      const prev = [...sorted].reverse().find((b) => toMinutes(b.end) <= t);
      return { id: r.id, name: r.name, busy: sorted, now, next, freeFrom: now ? null : (prev?.end ?? null), freeUntil: now ? null : (next?.start ?? null) };
    });
  }, [q.data, view, at, date]);
  const free = rows.filter((r) => !r.now).sort((a, b) => a.name.localeCompare(b.name));
  const busy = rows.filter((r) => r.now).sort((a, b) => a.name.localeCompare(b.name));
  const isNow = date === today && at === nowHm();

  function schedule(r: Row) {
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
  }

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header info="busy" title="Who’s free" subtitle={view === 'teachers' ? 'Teachers' : 'Rooms'} />
      <View style={{ marginTop: 6 }}>
        <DayPicker today={today} value={date} onChange={setDate} />
      </View>
      <View style={{ marginTop: 14 }}>
        <Segmented
          value={view}
          options={[
            { value: 'teachers', label: 'Teachers' },
            { value: 'rooms', label: 'Rooms' },
          ]}
          onChange={setView}
        />
      </View>

      <Card style={styles.timeCard}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Clock3 color={colors.textMuted} size={16} />
          <Text variant="bodyStrong" style={{ flex: 1 }}>
            {isNow ? 'Right now' : `At ${hm12(at)}`}
          </Text>
          {!isNow ? <Button title="Now" kind="secondary" compact onPress={() => (setDate(today), setAt(nowHm()))} /> : null}
        </View>
        <TimeField label="Check time" value={at} onChange={setAt} />
      </Card>

      {q.isPending ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <View style={styles.stats}>
            <View style={[styles.stat, { borderColor: 'rgba(74,222,128,0.35)' }]}>
              <Text style={[styles.statN, { color: colors.green }]}>{free.length}</Text>
              <Text variant="small">free</Text>
            </View>
            <View style={styles.stat}>
              <Text style={[styles.statN, { color: busy.length ? colors.amber : colors.text }]}>{busy.length}</Text>
              <Text variant="small">{view === 'teachers' ? 'teaching' : 'in use'}</Text>
            </View>
          </View>

          <SectionLabel right={<Text variant="monoSmall">{free.length}</Text>}>{isNow ? 'Free now' : `Free at ${hm12(at)}`}</SectionLabel>
          {free.length === 0 ? (
            <Card>
              <Text variant="small">{`No ${view === 'teachers' ? 'teacher' : 'room'} is free at ${hm12(at)}.`}</Text>
            </Card>
          ) : (
            <Card padded={false}>
              {free.map((r, i) => (
                <PersonRow key={r.id} r={r} view={view} at={at} last={i === free.length - 1} onSchedule={() => schedule(r)} />
              ))}
            </Card>
          )}

          {busy.length ? (
            <>
              <SectionLabel right={<Text variant="monoSmall">{busy.length}</Text>}>{view === 'teachers' ? 'Teaching' : 'In use'}</SectionLabel>
              <Card padded={false}>
                {busy.map((r, i) => (
                  <PersonRow key={r.id} r={r} view={view} at={at} last={i === busy.length - 1} />
                ))}
              </Card>
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function PersonRow({ r, view, at, last, onSchedule }: { r: Row; view: 'teachers' | 'rooms'; at: string; last: boolean; onSchedule?: () => void }) {
  const status = r.now
    ? `${r.now.courseCode}${view === 'teachers' && r.now.room ? ` · ${r.now.room}` : ''} · till ${hm12(r.now.end)}`
    : r.freeUntil
      ? `Free till ${hm12(r.freeUntil)} · then ${r.next?.courseCode ?? 'a class'}`
      : r.busy.length
        ? 'Free for the rest of the day'
        : 'No classes this day';
  return (
    <View style={[styles.row, !last && styles.rowLine]}>
      <View style={styles.head}>
        {view === 'teachers' ? (
          <Avatar text={initials(r.name) || '?'} size={38} />
        ) : (
          <View style={styles.roomIcon}>
            <DoorOpen color={colors.text} size={18} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {r.name}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <View style={[styles.dot, { backgroundColor: r.now ? colors.amber : colors.green }]} />
            <Text variant="small" numberOfLines={1} style={{ flex: 1 }}>
              {status}
            </Text>
          </View>
        </View>
        {onSchedule ? (
          <Pressable onPress={onSchedule} accessibilityRole="button" accessibilityLabel={`Schedule a class with ${r.name}`} style={({ pressed }) => [styles.schedule, pressed && { opacity: 0.8 }]}>
            <CalendarPlus color={colors.ink} size={16} />
          </Pressable>
        ) : r.now ? (
          <Pressable
            onPress={() => router.push({ pathname: '/session/[id]', params: { id: r.now!.sessionId } })}
            accessibilityRole="button"
            accessibilityLabel={`Open ${r.now.courseCode}`}
            style={styles.open}
          >
            <UserRound color={colors.textMuted} size={15} />
          </Pressable>
        ) : null}
      </View>
      <Timeline blocks={r.busy} at={at} />
    </View>
  );
}

/** 8 AM → 6 PM: classes as blocks, the chosen time as a line. */
function Timeline({ blocks, at }: { blocks: BusyBlock[]; at: string }) {
  const pct = (hm: string) => `${((Math.min(Math.max(toMinutes(hm), DAY_START), DAY_END) - DAY_START) / (DAY_END - DAY_START)) * 100}%` as const;
  const width = (a: string, b: string) => `${Math.max(1.5, ((Math.min(toMinutes(b), DAY_END) - Math.max(toMinutes(a), DAY_START)) / (DAY_END - DAY_START)) * 100)}%` as const;
  return (
    <View style={{ marginTop: 10 }}>
      <View style={styles.track}>
        {blocks.map((b) => (
          <Pressable
            key={b.sessionId}
            onPress={() => router.push({ pathname: '/session/[id]', params: { id: b.sessionId } })}
            accessibilityRole="button"
            accessibilityLabel={`${b.courseCode} ${hm12(b.start)} to ${hm12(b.end)}`}
            style={[styles.block, { left: pct(b.start), width: width(b.start, b.end) }]}
          >
            <Text style={styles.blockText} numberOfLines={1}>
              {b.courseCode}
            </Text>
          </Pressable>
        ))}
        <View pointerEvents="none" style={[styles.cursor, { left: pct(at) }]} />
      </View>
      <View style={styles.ticks}>
        {['8a', '10a', '12p', '2p', '4p', '6p'].map((t) => (
          <Text key={t} style={styles.tick}>
            {t}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  timeCard: { marginTop: 14, gap: 12 },
  stats: { flexDirection: 'row', gap: 10, marginTop: 14 },
  stat: { flex: 1, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  statN: { fontFamily: fonts.display, fontSize: 26, color: colors.text },
  row: { paddingHorizontal: 14, paddingVertical: 14 },
  rowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  roomIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.borderHi },
  dot: { width: 7, height: 7, borderRadius: 4 },
  schedule: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.text },
  open: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.borderHi },
  track: { height: 24, borderRadius: 8, backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  block: { position: 'absolute', top: 2, bottom: 2, borderRadius: 5, backgroundColor: 'rgba(251, 191, 36, 0.85)', justifyContent: 'center', paddingHorizontal: 4 },
  blockText: { fontFamily: fonts.bold, fontSize: 9.5, color: colors.ink },
  cursor: { position: 'absolute', top: 0, bottom: 0, width: 2, marginLeft: -1, backgroundColor: colors.text },
  ticks: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  tick: { fontFamily: fonts.mono, fontSize: 9.5, color: colors.textDim },
});
