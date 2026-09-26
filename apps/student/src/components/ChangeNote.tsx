import { View } from 'react-native';
import { ArrowRightLeft, CalendarPlus, UserRound, XCircle } from 'lucide-react-native';
import type { SessionChange } from '@attendly/protocol';
import { Text } from '@kit/components/ui';
import { zoned, dayLabel } from '@kit/lib/format';
import { colors } from '@kit/theme';

/** One line explaining what changed about a class, e.g. "Moved from Tue 10:00". */
export function ChangeNote({ change, tz }: { change: SessionChange | null | undefined; tz?: string }) {
  if (!change) return null;
  const { kind } = change;
  const Icon = kind === 'rescheduled' ? ArrowRightLeft : kind === 'cancelled' ? XCircle : kind === 'extra' ? CalendarPlus : UserRound;
  const color = kind === 'cancelled' ? colors.red : kind === 'extra' ? colors.green : colors.violet;
  const base =
    kind === 'rescheduled'
      ? `Moved${change.originalStart ? ` from ${dayLabel(change.originalStart, tz)} ${zoned(change.originalStart, tz).hm}` : ''}${change.teacher ? ` · taken by ${change.teacher}` : ''}`
      : kind === 'cancelled'
        ? 'Cancelled'
        : kind === 'extra'
          ? `Extra class${change.teacher ? ` · by ${change.teacher}` : ''}`
          : `Taken by ${change.teacher ?? 'another teacher'}`;
  // The teacher's / admin's note for students ("Bring your lab records"), or the reason for a cancellation.
  const text = change.note ? `${base} — ${change.note}` : base;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }} accessibilityLabel={text}>
      <Icon color={color} size={12} />
      <Text variant="small" color={color} numberOfLines={3} style={{ flexShrink: 1 }}>
        {text}
      </Text>
    </View>
  );
}
