import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Bell } from 'lucide-react-native';
import { useNotifications } from '../lib/notifications';
import { colors, fonts } from '../theme';
import { Text } from './ui';

/** The bell with an unread count; opens the notifications list. */
export function NotificationBell() {
  const q = useNotifications();
  const unread = q.data?.unread ?? 0;
  return (
    <Pressable
      onPress={() => router.push('/notifications')}
      accessibilityRole="button"
      accessibilityLabel={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      hitSlop={8}
      style={styles.btn}
    >
      <Bell color={unread ? colors.text : colors.textMuted} size={20} />
      {unread ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{unread > 99 ? '99+' : String(unread)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  badge: { position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.bg },
  badgeText: { fontFamily: fonts.bold, fontSize: 10.5, color: '#fff' },
});
