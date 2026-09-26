import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import type { BusyBlock } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Card, ErrorState, Loading, Segmented, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { DateField, Header, TimeField, ToggleRow, toMinutes } from '@/components/forms';
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
  const [at, setAt] = useState('10:00');
  const q = useAvailability(date);
  const [width, setWidth] = useState(0);

  const rows = useMemo(() => {
    const list = view === 'teachers' ? (q.data?.teachers ?? []) : (q.data?.rooms ?? []);
    const t = toMinutes(at);
    const busyAt = (busy: BusyBlock[]) => busy.find((b) => toMinutes(b.start) <= t && t < toMinutes(b.end));
    return list
      .map((r) => ({ ...r, now: busyAt(r.busy) }))
      .filter((r) => !freeOnly || !r.now)
      .sort((a, b) => Number(!!a.now) - Number(!!b.now) || a.name.localeCompare(b.name));
  }, [q.data, view, freeOnly, at]);

  const x = (hm: string) => ((Math.min(Math.max(toMinutes(hm), DAY_START), DAY_END) - DAY_START) / (DAY_END - DAY_START)) * width;
  const hours = Array.from({ length: (DAY_END - DAY_START) / 60 + 1 }, (_, i) => DAY_START / 60 + i);

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header info="busy" title="Who’s busy where" />
      <DateField value={date} onChange={setDate} />
      <View style={{ marginTop: 12 }}>
        <Segmented value={view} options={[{ value: 'teachers', label: 'Teachers' }, { value: 'rooms', label: 'Rooms' }]} onChange={setView} />
      </View>
      <Card style={{ marginTop: 12, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Text variant="label">At</Text>
          <TimeField label="Check time" value={at} onChange={setAt} />
        </View>
        <ToggleRow label={view === 'teachers' ? 'Only teachers free then' : 'Only rooms free then'} value={freeOnly} onChange={setFreeOnly} />
      </Card>

      {q.isPending ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <View style={{ marginTop: 14, gap: 10 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width - 28)}>
          <View style={[styles.axis, { marginLeft: 14, width }]}>
            {hours.map((h) => (
              <Text key={h} style={[styles.hour, { left: x(`${String(h).padStart(2, '0')}:00`) - 8 }]}>
                {h}
              </Text>
            ))}
          </View>
          {rows.length === 0 ? (
            <Text variant="small">{freeOnly ? `No one is free at ${at}.` : 'Nothing here.'}</Text>
          ) : (
            rows.map((r) => (
              <Card key={r.id} style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text variant="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>
                    {r.name}
                  </Text>
                  {r.now ? <Badge label={`${at}: ${r.now.courseCode}${r.now.room && view === 'teachers' ? ` · ${r.now.room}` : ''}`} tone="amber" dot={false} /> : <Badge label={`Free at ${at}`} tone="green" dot={false} />}
                </View>
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
                  <Text variant="small" numberOfLines={2}>
                    {r.busy.map((b) => `${b.start}–${b.end} ${b.courseCode}${view === 'teachers' ? (b.room ? ` (${b.room})` : '') : ''}${b.substitute ? ' · sub' : ''}`).join(' · ')}
                  </Text>
                ) : (
                  <Text variant="small" color={colors.green}>
                    Free all day
                  </Text>
                )}
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
  hour: { position: 'absolute', width: 16, textAlign: 'center', fontFamily: fonts.mono, fontSize: 10, color: colors.textDim },
  track: { height: 26, borderRadius: 8, backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  block: { position: 'absolute', top: 2, bottom: 2, borderRadius: 6, backgroundColor: 'rgba(255, 255, 255, 0.55)', justifyContent: 'center', paddingHorizontal: 4 },
  blockText: { fontFamily: fonts.semibold, fontSize: 10, color: '#fff' },
  cursor: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: colors.amber },
});
