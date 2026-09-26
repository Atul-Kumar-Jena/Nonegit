import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { AlarmClock, Bell, Building2, CalendarDays, CalendarRange, ChevronRight, Clock4, Inbox, KeyRound, Library, Lock, LogOut, MapPin, Play, Plus, ShieldAlert, Smartphone, Trash2, UserPlus, Users, UsersRound, Wand2, FileBarChart } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { SyncBanner } from '@kit/components/SyncBanner';
import { Avatar, Badge, Button, Card, Divider, InfoRow, SectionLabel, Text } from '@kit/components/ui';
import { APP_VERSION } from '@kit/lib/env';
import { initials } from '@kit/lib/format';
import { useOutbox } from '@kit/lib/outbox';
import { setScreenshotsBlocked, useScreenshotsBlocked } from '@kit/lib/screenshots';
import { displayHost } from '@kit/lib/server-config';
import { useSession } from '@kit/state/session';
import { colors } from '@kit/theme';
import { confirmAction } from '@/components/forms';
import { FeatureGrid, InfoButton } from '@kit/components/Features';
import { HELP } from '@/help';
import { localSessions } from '@/local-sessions';
import { useMe, useOverview } from '@/queries';

/** Everything else: people, rooms, reviews, settings, your account. */
export default function More() {
  const me = useMe();
  const overview = useOverview();
  const { server, signOut, resetPhone } = useSession();
  const { items: unsent } = useOutbox();
  const u = me.data?.user;
  const shotsBlocked = useScreenshotsBlocked();
  const admin = u?.role === 'admin';
  const warn = unsent.length
    ? `\n\n⚠ ${unsent.length} offline ${unsent.length === 1 ? 'change has' : 'changes have'} not been uploaded yet (registers, class starts) and will be lost. Connect to the internet first.`
    : '';

  async function fullSignOut() {
    await localSessions.wipe().catch(() => undefined);
    await signOut();
  }

  return (
    <Screen onRefresh={() => void me.refetch()} refreshing={me.isRefetching}>
      <View style={[styles.row, { marginTop: 4 }]}>
        <Text variant="title" style={{ flex: 1 }}>
          More
        </Text>
        <InfoButton title={HELP.more!.title} text={HELP.more!.text} />
      </View>
      <Card style={[styles.row, { marginTop: 16 }]}>
        <Avatar text={initials(u?.fullName ?? 'A')} size={48} />
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">{u?.fullName ?? '…'}</Text>
          <Text variant="small">{u?.email ?? u?.phone ?? ''}</Text>
          <Text variant="small">{u?.institution.name ?? ''}</Text>
        </View>
        {u ? <Badge label={admin ? 'Admin' : 'Teacher'} tone={admin ? 'violet' : 'cyan'} dot={false} /> : null}
      </Card>

      <SyncBanner />

      <SectionLabel>All features</SectionLabel>
      <FeatureGrid
        items={[
          { icon: <Play color={colors.text} size={18} />, label: 'Take attendance', href: '/attend' },
          { icon: <CalendarDays color={colors.text} size={18} />, label: 'Timetable', href: '/timetable' },
          { icon: <Library color={colors.text} size={18} />, label: 'Classes & reports', href: '/classes' },
          { icon: <FileBarChart color={colors.text} size={18} />, label: 'Attendance reports', href: '/reports' },
          { icon: <Plus color={colors.text} size={18} />, label: 'Extra class', href: '/extra-class' },
          { icon: <Inbox color={colors.text} size={18} />, label: 'Requests', href: '/inbox' },
          { icon: <Clock4 color={colors.text} size={18} />, label: 'Who’s busy', href: '/busy' },
          ...(admin
            ? [
                { icon: <UserPlus color={colors.text} size={18} />, label: 'Cover a class', href: '/cover' as Href },
                { icon: <CalendarRange color={colors.text} size={18} />, label: 'Planner', href: '/planner' as Href },
                { icon: <Users color={colors.text} size={18} />, label: 'People', href: '/people' as Href },
              ]
            : []),
          { icon: <UsersRound color={colors.text} size={18} />, label: 'Batches', href: '/batches' },
          { icon: <MapPin color={colors.text} size={18} />, label: 'Rooms', href: '/rooms' },
          ...(admin
            ? [
                { icon: <Smartphone color={colors.text} size={18} />, label: 'Phone requests', href: '/requests' as Href, badge: overview.data?.pendingRequests ? String(overview.data.pendingRequests) : null },
                { icon: <ShieldAlert color={colors.text} size={18} />, label: 'Suspicious scans', href: '/flags' as Href, badge: overview.data?.flaggedOpen ? String(overview.data.flaggedOpen) : null },
                { icon: <Building2 color={colors.text} size={18} />, label: 'Institution', href: '/institution' as Href },
                { icon: <Wand2 color={colors.text} size={18} />, label: 'Setup checklist', href: '/setup' as Href },
              ]
            : []),
          { icon: <Bell color={colors.text} size={18} />, label: 'Notifications', href: '/notifications' },
          { icon: <AlarmClock color={colors.text} size={18} />, label: 'Class reminders', href: '/reminders' },
          { icon: <KeyRound color={colors.text} size={18} />, label: 'Sign-in security', href: '/security' },
          { icon: <Lock color={colors.text} size={18} />, label: 'Permissions', href: '/permissions' },
        ]}
      />

      <SectionLabel>This phone</SectionLabel>
      <Card>
        <View style={styles.row}>
          <Lock color={colors.green} size={18} />
          <Text variant="small" color={colors.text} style={{ flex: 1 }}>
            App lock on · data encrypted on the phone
          </Text>
        </View>
        <Divider style={{ marginVertical: 12 }} />
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">Block screenshots</Text>
            <Text variant="small">Also hides the app in the recent-apps view. Leave off to capture screens (e.g. to report a bug).</Text>
          </View>
          <Switch
            value={shotsBlocked}
            onValueChange={(v) => void setScreenshotsBlocked(v)}
            trackColor={{ true: colors.text, false: colors.borderHi }}
            thumbColor={shotsBlocked ? colors.bg : colors.textMuted}
            accessibilityLabel="Block screenshots"
          />
        </View>
        <Divider style={{ marginVertical: 12 }} />
        <InfoRow label="DEVICE" value={me.data ? `${me.data.device.model} · ${me.data.device.fingerprint}` : '—'} />
        <InfoRow label="SERVER" value={server ? displayHost(server.url) : '—'} />
        <InfoRow label="SERVER KEY" value={server?.kid ?? '—'} />
        <InfoRow label="VERSION" value={APP_VERSION} />
      </Card>

      <View style={{ gap: 10, marginTop: 16 }}>
        <Button
          title="Sign out"
          kind="secondary"
          icon={<LogOut color={colors.text} size={16} />}
          onPress={() => confirmAction('Sign out?', `This phone stays bound to your account; sign back in with a new code.${warn}`, 'Sign out', () => void fullSignOut(), unsent.length > 0)}
        />
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            confirmAction(
              'Erase this phone’s identity?',
              `Deletes the device key and everything saved on this phone. Another admin must approve before this account works on a phone again.${warn}`,
              'Erase',
              () => void localSessions.wipe().then(() => resetPhone()),
              true,
            )
          }
          style={styles.erase}
          hitSlop={8}
        >
          <Trash2 color={colors.textDim} size={14} />
          <Text variant="small" color={colors.textDim}>
            Erase device identity
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

function Item({ icon, label, sub, href, badge, last }: { icon: ReactNode; label: string; sub?: string; href: Href; badge?: string; last?: boolean }) {
  return (
    <Pressable onPress={() => router.push(href)} accessibilityRole="button" accessibilityLabel={label} style={[styles.item, !last && styles.itemLine]}>
      {icon}
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong">{label}</Text>
        {sub ? <Text variant="small">{sub}</Text> : null}
      </View>
      {badge ? <Badge label={badge} tone="amber" dot={false} /> : null}
      <ChevronRight color={colors.textDim} size={16} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  itemLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  erase: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10 },
});
