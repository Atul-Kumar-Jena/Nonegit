import { Pressable, StyleSheet, View } from 'react-native';
import { Lightbulb, TriangleAlert } from 'lucide-react-native';
import { Card, Text } from '@kit/components/ui';
import { colors } from '@kit/theme';
import { hm12, toMinutes } from '@/components/forms';
import { useAvailability } from '@/queries';

/**
 * Suggestions while scheduling a class: which rooms are free for the whole time (tap one to use it),
 * and a warning when the professor already teaches then — with the next time they're free.
 */
export function ScheduleHints({
  date,
  start,
  end,
  teacherId,
  teacherName,
  roomId,
  onRoom,
}: {
  date: string;
  start: string;
  end: string;
  teacherId: string | null;
  teacherName: string | null;
  roomId: string | null;
  onRoom: (id: string) => void;
}) {
  const q = useAvailability(date, 1, toMinutes(end) > toMinutes(start));
  if (!q.data) return null;
  const s = toMinutes(start);
  const e = toMinutes(end);
  const overlaps = (b: { start: string; end: string }) => toMinutes(b.start) < e && s < toMinutes(b.end);
  const freeRooms = q.data.rooms.filter((r) => !r.busy.some(overlaps));
  const roomBusy = roomId ? q.data.rooms.find((r) => r.id === roomId)?.busy.find(overlaps) : undefined;
  const teacher = teacherId ? q.data.teachers.find((t) => t.id === teacherId) : undefined;
  const clash = teacher?.busy.find(overlaps);
  // The professor's next free window of the same length that day.
  let nextFree: string | null = null;
  if (clash && teacher) {
    const len = e - s;
    const blocks = [...teacher.busy].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    let t = toMinutes(clash.end);
    for (const b of blocks) {
      if (toMinutes(b.end) <= t) continue;
      if (toMinutes(b.start) >= t + len) break;
      t = Math.max(t, toMinutes(b.end));
    }
    if (t + len <= 22 * 60) nextFree = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }
  if (!clash && !roomBusy && freeRooms.length === 0) return null;
  return (
    <Card style={{ gap: 8, marginTop: 14 }}>
      {clash ? (
        <View style={styles.line}>
          <TriangleAlert color={colors.amber} size={16} />
          <Text variant="small" color={colors.amber} style={{ flex: 1 }}>
            {`${teacherName ?? 'The professor'} teaches ${clash.courseCode} ${hm12(clash.start)}–${hm12(clash.end)} then.${nextFree ? ` Free again at ${hm12(nextFree)}.` : ''}`}
          </Text>
        </View>
      ) : null}
      {roomBusy ? (
        <View style={styles.line}>
          <TriangleAlert color={colors.amber} size={16} />
          <Text variant="small" color={colors.amber} style={{ flex: 1 }}>
            {`That room has ${roomBusy.courseCode} ${hm12(roomBusy.start)}–${hm12(roomBusy.end)}.`}
          </Text>
        </View>
      ) : null}
      {freeRooms.length ? (
        <>
          <View style={styles.line}>
            <Lightbulb color={colors.text} size={16} />
            <Text variant="small" color={colors.text} style={{ flex: 1 }}>
              {`Free for the whole ${hm12(start)}–${hm12(end)}:`}
            </Text>
          </View>
          <View style={styles.chips}>
            {freeRooms.slice(0, 8).map((r) => (
              <Pressable key={r.id} onPress={() => onRoom(r.id)} accessibilityRole="button" style={[styles.chip, r.id === roomId && styles.chipOn]}>
                <Text variant="small" color={r.id === roomId ? colors.bg : colors.text}>
                  {r.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
});
