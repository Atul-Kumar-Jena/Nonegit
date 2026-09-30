import { useCallback } from 'react';
import { Pressable, Share, StyleSheet, Switch, View } from 'react-native';
import { useFocusEffect, type Href } from 'expo-router';
import { Share2, Megaphone, AlarmClock, Bell, Building2, CalendarRange, Clock4, Inbox, KeyRound, Library, Lock, LogOut, MapPin, Play, Plus, ShieldAlert, Smartphone, Trash2, UserPlus, Users, UsersRound, Wand2, FileBarChart, Timer } from 'lucide-react-native';
import { formatInstitutionCode, type StaffPermission } from '@attendly/protocol';
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
import { useNoticeInbox } from '@kit/components/Notices';
import { FeatureList, InfoButton } from '@kit/components/Features';
import { HELP } from '@/help';
import { localSessions } from '@/local-sessions';
import { useMe, useOverview } from '@/queries';

/** Everything else: people, rooms, reviews, settings, your account. */
export default function More() {
  const notices = useNoticeInbox();
  const me = useMe();
  // Role / permissions may have just been changed by an admin: re-check whenever this tab is shown.
  useFocusEffect(useCallback(() => void me.refetch(), [me.refetch]));
  const overview = useOverview();
  const { server, signOut, resetPhone } = useSession();
  const { items: unsent } = useOutbox();
  const u = me.data?.user;
  const shotsBlocked = useScreenshotsBlocked();
  const admin = u?.role === 'admin';
  const perms = new Set(me.data?.permissions ?? []);
  const may = (p: StaffPermission) => admin || perms.has(p);
  const mentorOf = me.data?.mentorOf ?? [];
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
          {u?.institution.code ? (
            <Pressable
              onPress={() =>
                void Share.share({
                  message: `${u.institution.name} on Attendly\nInstitution code: ${formatInstitutionCode(u.institution.code)}\nInstall Attendly Institute, enter this code, then sign in with the email the institution registered for you.`,
                }).catch(() => undefined)
              }
              accessibilityRole="button"
              accessibilityLabel="Share the institution code"
              hitSlop={6}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}
            >
              <Text variant="monoSmall" color={colors.text}>{`Code ${formatInstitutionCode(u.institution.code)}`}</Text>
              <Share2 color={colors.textDim} size={13} />
            </Pressable>
          ) : null}
        </View>
        {u ? <Badge label={admin ? (me.data?.owner ? 'Main admin' : 'Admin') : perms.size ? `Professor · +${perms.size}` : 'Professor'} tone={admin ? 'violet' : 'cyan'} dot={false} /> : null}
      </Card>
      <SyncBanner />

      {/* Grouped, one line each — every feature is still one tap away. */}
      <FeatureList
        title="Classes"
        items={[
          { icon: <Play color={colors.text} size={18} />, label: 'Take attendance', href: '/attend' },
          { icon: <Plus color={colors.text} size={18} />, label: 'Extra class', href: '/extra-class' },
          { icon: <Clock4 color={colors.text} size={18} />, label: 'Who’s free', href: '/busy' },
          ...(may('planner')
            ? [
                { icon: <UserPlus color={colors.text} size={18} />, label: 'Cover a class', href: '/cover' as Href },
                { icon: <CalendarRange color={colors.text} size={18} />, label: 'Planner', href: '/planner' as Href },
              ]
            : []),
          { icon: <Inbox color={colors.text} size={18} />, label: 'Requests', href: '/inbox' },
        ]}
      />
      <FeatureList
        title="Reports"
        items={[
          { icon: <FileBarChart color={colors.text} size={18} />, label: 'Attendance reports', href: '/reports' },
          { icon: <Library color={colors.text} size={18} />, label: 'Classes & registers', href: '/classes' },
          { icon: <Timer color={colors.text} size={18} />, label: may('courses') || may('planner') ? 'Professors’ punctuality' : 'My punctuality', href: '/professors' as Href },
        ]}
      />
      <FeatureList
        title="Institution"
        items={[
          { icon: <Megaphone color={colors.text} size={18} />, label: 'Notice centre', href: '/notices', badge: notices.data?.unread ? String(notices.data.unread) : undefined },
          ...(may('people') ? [{ icon: <Users color={colors.text} size={18} />, label: 'People & roles', href: '/people' as Href }] : []),
          { icon: <UsersRound color={colors.text} size={18} />, label: 'Batches', href: '/batches' },
          { icon: <MapPin color={colors.text} size={18} />, label: 'Rooms', href: '/rooms' },
          ...(may('devices') || mentorOf.length
            ? [{ icon: <Smartphone color={colors.text} size={18} />, label: 'Phone requests', href: '/requests' as Href, badge: overview.data?.pendingRequests ? String(overview.data.pendingRequests) : undefined }]
            : []),
          ...(may('devices') ? [{ icon: <ShieldAlert color={colors.text} size={18} />, label: 'Suspicious scans', href: '/flags' as Href, badge: overview.data?.flaggedOpen ? String(overview.data.flaggedOpen) : undefined }] : []),
          ...(admin
            ? [
                { icon: <Building2 color={colors.text} size={18} />, label: 'Institution settings', href: '/institution' as Href },
                { icon: <Wand2 color={colors.text} size={18} />, label: 'Setup checklist', href: '/setup' as Href },
              ]
            : []),
        ]}
      />
      <FeatureList
        title="You"
        items={[
          { icon: <Bell color={colors.text} size={18} />, label: 'Notifications', href: '/notifications' },
          { icon: <AlarmClock color={colors.text} size={18} />, label: 'Class reminders', href: '/reminders' },
          { icon: <KeyRound color={colors.text} size={18} />, label: 'Sign-in security', href: '/security' },
          { icon: <Lock color={colors.text} size={18} />, label: 'Phone permissions', href: '/permissions' },
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
        <InfoRow label="PHONE" value={me.data ? me.data.device.model : '—'} mono={false} />
        <InfoRow label="SERVER" value={server ? displayHost(server.url) : '—'} />
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

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  erase: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10 },
});
