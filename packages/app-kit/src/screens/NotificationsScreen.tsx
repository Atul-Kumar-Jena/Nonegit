import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, ArrowRight, BellRing, CalendarClock, CheckCheck, CircleCheckBig, Megaphone, MessageSquareText, ShieldAlert, Smartphone } from 'lucide-react-native';
import { NOTIFICATION_CATEGORIES, notificationCategory, type AppNotification, type NotificationCategory } from '@attendly/protocol';
import { Screen } from '../components/Screen';
import { Button, Card, ErrorState, IconButton, Loading, Notice, Text } from '../components/ui';
import { clock } from '../lib/format';
import { enablePhoneNotifications, phoneNotificationStatus, sendTestNotification, targetOf, useMarkRead, useNotifications } from '../lib/notifications';
import { useApi, useSession } from '../state/session';
import { colors, fonts } from '../theme';

const CATEGORY_ICON: Record<NotificationCategory, typeof CalendarClock> = {
  class: CalendarClock,
  notice: Megaphone,
  attendance: CircleCheckBig,
  request: MessageSquareText,
  phone: Smartphone,
  security: ShieldAlert,
};

const DAY = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2:05 PM" today, "Mon" this week, else "12 Sep". */
function when(iso: string): string {
  const t = Date.parse(iso);
  const today = startOfDay(Date.now());
  if (t >= today) return clock(iso);
  if (t >= today - 6 * DAY) return SHORT_DAY[new Date(t).getDay()]!;
  const d = new Date(t);
  return `${d.getDate()} ${SHORT_MONTH[d.getMonth()]}`;
}
function groupLabel(t: number): string {
  const today = startOfDay(Date.now());
  if (t >= today) return 'Today';
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 6 * DAY) return 'This week';
  return 'Earlier';
}

/** Everything sent to this person, newest first: grouped by day, filterable, one look per kind. */
export default function NotificationsScreen() {
  const { audience } = useSession();
  const q = useNotifications();
  const markRead = useMarkRead();
  const [phone, setPhone] = useState<'granted' | 'denied' | 'unavailable' | null>(null);
  const [open, setOpen] = useState<AppNotification | null>(null);
  /** Where "Open" goes for a notification — nothing when it isn't about something that has a screen. */
  const routeOf = (n: AppNotification): string | null => {
    const t = targetOf(n);
    const r = audience.routeFor?.(t) ?? (n.kind === 'request' || n.kind === 'cover' ? audience.requestsRoute : null);
    return typeof r === 'string' ? r : null;
  };
  const api = useApi();
  const [test, setTest] = useState<{ busy: boolean; msg: string | null; tone: 'green' | 'amber' | 'red' }>({ busy: false, msg: null, tone: 'green' });
  async function runTest() {
    setTest({ busy: true, msg: null, tone: 'green' });
    try {
      const r = await sendTestNotification(api);
      if (!r.allowed) setTest({ busy: false, tone: 'amber', msg: 'Sent — but phone notifications are off for this app. Turn them on (above) to see it on the lock screen.' });
      else if (!r.serverPush) setTest({ busy: false, tone: 'amber', msg: 'Sent. The server isn’t connected to Firebase yet, so it arrives only while the app is open or at its next check (~15 min).' });
      else if (!r.phoneRegistered) setTest({ busy: false, tone: 'amber', msg: 'Sent, but this phone isn’t registered for instant notifications (this build has no Firebase, or Google Play services are missing).' });
      else setTest({ busy: false, tone: 'green', msg: 'Sent! Close the app now — it should pop up within a few seconds. If it doesn’t: Settings → Apps → this app → Battery → No restrictions, and allow Auto-start.' });
    } catch (e) {
      setTest({ busy: false, tone: 'red', msg: e instanceof Error ? e.message : 'Couldn’t send a test.' });
    }
  }

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
  const [filter, setFilter] = useState<'all' | 'unread' | NotificationCategory>('all');
  const items = q.data?.items ?? [];
  const present = useMemo(() => new Set(items.map((n) => notificationCategory(n.kind))), [items]);
  const filters = [
    { value: 'all' as const, label: 'All' },
    ...(unread ? [{ value: 'unread' as const, label: `Unread · ${unread}` }] : []),
    ...(Object.keys(NOTIFICATION_CATEGORIES) as NotificationCategory[]).filter((c) => present.has(c)).map((c) => ({ value: c, label: NOTIFICATION_CATEGORIES[c].label })),
  ];
  const groups = useMemo(() => {
    const shown = items.filter((n) => (filter === 'all' ? true : filter === 'unread' ? !n.read : notificationCategory(n.kind) === filter));
    const out: { label: string; items: typeof shown }[] = [];
    for (const n of shown) {
      const label = groupLabel(Date.parse(n.createdAt));
      const g = out.find((x) => x.label === label);
      if (g) g.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [items, filter]);

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

      <Card style={{ gap: 8, marginTop: 8 }}>
        <View style={styles.row}>
          <BellRing color={colors.text} size={18} />
          <Text variant="small" color={colors.text} style={{ flex: 1 }}>
            Check this phone gets notifications instantly, even when the app is closed.
          </Text>
        </View>
        <Button title="Send me a test notification" kind="secondary" compact loading={test.busy} onPress={() => void runTest()} />
        {test.msg ? <Notice tone={test.tone} message={test.msg} onDismiss={() => setTest((t) => ({ ...t, msg: null }))} /> : null}
      </Card>

      {q.isPending ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (q.data?.items.length ?? 0) === 0 ? (
        <View style={{ marginTop: 40, alignItems: 'center', gap: 8 }}>
          <CalendarClock color={colors.textDim} size={28} />
          <Text variant="bodyStrong">Nothing yet</Text>
          <Text variant="small" style={{ textAlign: 'center' }}>
            Moved, cancelled or extra classes, notices, confirmations and requests show up here.
          </Text>
        </View>
      ) : (
        <>
          {q.isError ? <Notice tone="amber" message="Offline — showing the last notifications saved on this phone." /> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters} style={{ marginTop: 6, marginHorizontal: -4 }}>
            {filters.map((f) => {
              const on = f.value === filter;
              return (
                <Pressable key={f.value} onPress={() => setFilter(f.value)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={[styles.filter, on && styles.filterOn]}>
                  <Text style={[styles.filterText, on && { color: colors.bg }]}>{f.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {groups.length === 0 ? (
            <Text variant="small" style={{ marginTop: 20, textAlign: 'center' }}>
              Nothing here.
            </Text>
          ) : (
            groups.map((g) => (
              <View key={g.label} style={{ marginTop: 14 }}>
                <Text variant="label" style={{ marginBottom: 6 }}>
                  {g.label}
                </Text>
                <Card padded={false} style={{ overflow: 'hidden' }}>
                  {g.items.map((n, i) => {
                    const cat = notificationCategory(n.kind);
                    const look = NOTIFICATION_CATEGORIES[cat];
                    const Icon = CATEGORY_ICON[cat];
                    return (
                      <Pressable
                        key={n.id}
                        onPress={() => {
                          if (!n.read) void markRead([n.id]);
                          setOpen(n);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`${n.read ? '' : 'Unread. '}${n.title}. ${n.body}`}
                        style={({ pressed }) => [styles.item, i > 0 && styles.itemDivider, pressed && { backgroundColor: colors.cardHi }]}
                      >
                        <View style={[styles.thumb, { backgroundColor: `${look.color}22`, borderColor: `${look.color}55` }]}>
                          <Icon color={look.color} size={19} />
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <View style={styles.row}>
                            <Text variant={n.read ? 'body' : 'bodyStrong'} numberOfLines={1} style={{ flex: 1, color: colors.text }}>
                              {n.title}
                            </Text>
                            <Text variant="small" style={{ fontSize: 12 }}>
                              {when(n.createdAt)}
                            </Text>
                          </View>
                          <Text variant="small" numberOfLines={2}>
                            {n.body}
                          </Text>
                          <Text variant="small" style={{ fontSize: 11.5 }} color={colors.textDim}>
                            {look.label}
                          </Text>
                        </View>
                        {!n.read ? <View style={styles.dot} /> : null}
                      </Pressable>
                    );
                  })}
                </Card>
              </View>
            ))
          )}
        </>
      )}
      <Modal visible={!!open} transparent animationType="slide" onRequestClose={() => setOpen(null)}>
        <Pressable style={styles.scrim} onPress={() => setOpen(null)} accessibilityLabel="Close" />
        {open ? <Detail n={open} onClose={() => setOpen(null)} route={routeOf(open)} /> : null}
      </Modal>
    </Screen>
  );
}

/** One notification in full: what, when, the whole message, and a way to the thing it's about. */
function Detail({ n, onClose, route }: { n: AppNotification; onClose: () => void; route: string | null }) {
  const cat = notificationCategory(n.kind);
  const look = NOTIFICATION_CATEGORIES[cat];
  const Icon = CATEGORY_ICON[cat];
  const d = new Date(n.createdAt);
  return (
    <View style={styles.sheet}>
      <View style={styles.grab} />
      <View style={[styles.row, { gap: 12 }]}>
        <View style={[styles.thumb, { backgroundColor: `${look.color}22`, borderColor: `${look.color}55` }]}>
          <Icon color={look.color} size={19} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="small">{look.label}</Text>
          <Text variant="small">{`${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} · ${clock(n.createdAt)}`}</Text>
        </View>
      </View>
      <ScrollView style={{ maxHeight: 360, marginTop: 14 }} contentContainerStyle={{ gap: 8 }}>
        <Text variant="heading">{n.title}</Text>
        <Text variant="body" selectable style={{ lineHeight: 22 }}>
          {n.body}
        </Text>
      </ScrollView>
      <View style={{ gap: 10, marginTop: 18 }}>
        {route ? (
          <Button
            title={cat === 'notice' ? 'Open the notice' : cat === 'request' ? 'Open requests' : cat === 'phone' ? 'Open phone requests' : cat === 'attendance' ? 'Open the subject' : 'Open the class'}
            onPress={() => {
              onClose();
              router.push(route as never);
            }}
            icon={<ArrowRight color={colors.bg} size={16} />}
          />
        ) : null}
        <Button title="Close" kind="secondary" onPress={onClose} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.text },
  filters: { gap: 8, paddingHorizontal: 4 },
  filter: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: colors.borderHi },
  filterOn: { backgroundColor: colors.text, borderColor: colors.text },
  filterText: { fontSize: 13, color: colors.text, fontFamily: fonts.medium },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  itemDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  thumb: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { backgroundColor: colors.bgRaised, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 34, borderTopWidth: 1, borderColor: colors.border },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderHi, marginBottom: 14 },
});
