import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, ClipboardList, CloudUpload, QrCode, ShieldAlert } from 'lucide-react-native';
import type { StaffSession } from '@attendly/protocol';
import { Badge, Card, Text } from '@kit/components/ui';
import { timeRange } from '@kit/lib/format';
import { colors } from '@kit/theme';

export function StatusBadge({ s }: { s: StaffSession & { pendingSync?: boolean } }) {
  if (s.status === 'live') return <Badge label="LIVE" tone="cyan" />;
  if (s.status === 'closed') return <Badge label="Done" tone="green" dot={false} />;
  if (s.status === 'cancelled') return <Badge label="Cancelled" tone="red" dot={false} />;
  return <Badge label="Scheduled" tone="muted" dot={false} />;
}

export function SessionCard({ s, tz, showDate }: { s: StaffSession & { pendingSync?: boolean }; tz: string; showDate?: string }) {
  const live = s.status === 'live';
  return (
    <Pressable onPress={() => router.push({ pathname: '/session/[id]', params: { id: s.id } })} accessibilityRole="button" accessibilityLabel={`${s.courseCode} ${s.courseTitle}, ${s.status}`}>
      <Card style={[styles.card, live && { borderColor: 'rgba(255, 255, 255, 0.4)' }, s.status === 'cancelled' && { opacity: 0.6 }]} padded={false}>
        <View style={[styles.accent, { backgroundColor: live ? colors.cyan : s.status === 'closed' ? colors.green : s.status === 'cancelled' ? colors.red : colors.borderHi }]} />
        <View style={{ flex: 1, paddingVertical: 13, paddingLeft: 14, gap: 3 }}>
          <View style={styles.row}>
            <Text variant="monoSmall">
              {showDate ? `${showDate} · ` : ''}
              {timeRange(s.scheduledStart, s.scheduledEnd, tz)}
            </Text>
            {s.mode === 'manual' ? <ClipboardList color={colors.violet} size={13} /> : <QrCode color={colors.textDim} size={13} />}
          </View>
          <Text variant="bodyStrong" numberOfLines={1}>
            {s.courseCode} · {s.courseTitle}
          </Text>
          <View style={styles.row}>
            <Text variant="small" numberOfLines={1} style={{ flexShrink: 1 }}>
              {[s.room?.name ?? s.roomLabel, s.lectureNo ? `Lecture ${s.lectureNo}` : null, s.status !== 'scheduled' && s.status !== 'cancelled' ? `${s.marked}/${s.enrolled} present` : `${s.enrolled} students`]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <View style={[styles.row, { marginTop: 4 }]}>
            <StatusBadge s={s} />
            {s.flagged > 0 ? <Badge label={`${s.flagged} flagged`} tone="amber" icon={<ShieldAlert color={colors.amber} size={11} />} /> : null}
            {s.pendingSync ? <Badge label="Waiting to sync" tone="violet" icon={<CloudUpload color={colors.violet} size={11} />} /> : null}
            {s.substitute ? <Badge label={`Sub: ${s.substitute.name}`} tone="violet" dot={false} /> : null}
            {s.change?.kind === 'rescheduled' ? <Badge label="Moved" tone="amber" dot={false} /> : null}
            {s.change?.kind === 'extra' ? <Badge label="Extra" tone="green" dot={false} /> : null}
          </View>
        </View>
        <View style={{ paddingHorizontal: 12 }}>
          <ChevronRight color={colors.textDim} size={18} />
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  accent: { width: 3, alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
});
