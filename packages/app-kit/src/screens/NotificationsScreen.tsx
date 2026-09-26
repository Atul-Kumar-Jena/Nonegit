import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, BellRing, CalendarClock, CheckCheck } from 'lucide-react-native';
import { Screen } from '../components/Screen';
import { Button, Card, ErrorState, IconButton, Loading, Notice, Text } from '../components/ui';
import { timeAgo } from '../lib/format';
import { enablePhoneNotifications, phoneNotificationStatus, useMarkRead, useNotifications } from '../lib/notifications';
import { colors } from '../theme';

/** Every timetable change sent to this person, newest first. */
export default function NotificationsScreen() {
  const q = useNotifications();
  const markRead = useMarkRead();
  const [phone, setPhone] = useState<'granted' | 'denied' | 'unavailable' | null>(null);

  useEffect(() => {
    void phoneNotificationStatus().then(setPhone);
    // Opening the list always shows the latest, not the last background poll.
    void q.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const back = (
    <IconButton label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}>
      <ArrowLeft color={colors.text} size={18} />
    </IconButton>
  );
  const unread = q.data?.unread ?? 0;

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <View style={styles.header}>
        {back}
        <Text variant="heading" style={{ flex: 1 }}>
          Notifications
        </Text>
        {unread ? <Button title="Mark all read" kind="secondary" compact onPress={() => void markRead('all')} icon={<CheckCheck color={colors.text} size={14} />} /> : null}
      </View>

      {phone === 'denied' ? (
        <Card tone="amber" style={{ gap: 10, marginTop: 8 }}>
          <View style={styles.row}>
            <BellRing color={colors.amber} size={18} />
            <Text variant="small" color={colors.text} style={{ flex: 1 }}>
              Phone notifications are off. Turn them on to hear about moved, cancelled or extra classes even when the app is closed.
            </Text>
          </View>
          <Button title="Turn on notifications" compact onPress={() => void enablePhoneNotifications().then(setPhone)} />
        </Card>
      ) : null}

      {q.isPending ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (q.data?.items.length ?? 0) === 0 ? (
        <View style={{ marginTop: 40, alignItems: 'center', gap: 8 }}>
          <CalendarClock color={colors.textDim} size={28} />
          <Text variant="bodyStrong">Nothing yet</Text>
          <Text variant="small" style={{ textAlign: 'center' }}>
            When a class is moved, cancelled, taken by another teacher, or an extra class is added, you’ll see it here.
          </Text>
        </View>
      ) : (
        <View style={{ gap: 10, marginTop: 10 }}>
          {q.isError ? <Notice tone="amber" message="Offline — showing the last notifications saved on this phone." /> : null}
          {q.data!.items.map((n) => (
            <Pressable
              key={n.id}
              onPress={() => {
                if (!n.read) void markRead([n.id]);
                router.push('/timetable');
              }}
              accessibilityRole="button"
              accessibilityLabel={`${n.read ? '' : 'Unread. '}${n.title}. ${n.body}`}
            >
              <Card tone={n.read ? undefined : 'cyan'} style={{ gap: 6 }}>
                <View style={styles.row}>
                  {!n.read ? <View style={styles.dot} /> : null}
                  <Text variant="bodyStrong" style={{ flex: 1 }}>
                    {n.title}
                  </Text>
                  <Text variant="monoSmall">{timeAgo(n.createdAt)}</Text>
                </View>
                <Text variant="small" color={colors.text}>
                  {n.body}
                </Text>
              </Card>
            </Pressable>
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.cyan },
});
