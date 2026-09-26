import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { Bell, Building2, CalendarRange, ChevronRight, Clock4, Lock, LogOut, MapPin, ShieldAlert, Smartphone, Trash2, Users, UsersRound, Wand2 } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { SyncBanner } from '@kit/components/SyncBanner';
import { Avatar, Badge, Button, Card, Divider, InfoRow, SectionLabel, Text } from '@kit/components/ui';
import { APP_VERSION } from '@kit/lib/env';
import { initials } from '@kit/lib/format';
import { useOutbox } from '@kit/lib/outbox';
import { displayHost } from '@kit/lib/server-config';
import { useSession } from '@kit/state/session';
import { colors } from '@kit/theme';
import { confirmAction } from '@/components/forms';
import { localSessions } from '@/local-sessions';
import { useMe, useOverview } from '@/queries';

/** Everything else: people, rooms, reviews, settings, your account. */
export default function More() {
  const me = useMe();
  const overview = useOverview();
  const { server, signOut, resetPhone } = useSession();
  const { items: unsent } = useOutbox();
  const u = me.data?.user;
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
      <Text variant="title" style={{ marginTop: 4 }}>
        More
      </Text>
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

      <SectionLabel>Manage</SectionLabel>
      <Card padded={false}>
        {admin ? <Item icon={<Wand2 color={colors.violet} size={18} />} label="Setup checklist" href="/setup" /> : null}
        {admin ? <Item icon={<CalendarRange color={colors.cyan} size={18} />} label="Timetable planner" sub="Drag & drop changes, then publish" href="/planner" /> : null}
        <Item icon={<Clock4 color={colors.green} size={18} />} label="Who’s busy where" sub="Teachers and rooms, hour by hour" href="/busy" />
        <Item icon={<Bell color={colors.amber} size={18} />} label="Notifications" href="/notifications" />
        <Item icon={<Lock color={colors.textMuted} size={18} />} label="Permissions" sub="Location and notifications" href="/permissions" />
        {admin ? <Item icon={<Users color={colors.cyan} size={18} />} label="People" sub="Students, teachers, admins" href="/people" /> : null}
        <Item icon={<UsersRound color={colors.violet} size={18} />} label="Batches" sub="Sections and the courses they take" href="/batches" />
        <Item icon={<MapPin color={colors.green} size={18} />} label="Rooms" sub="Classroom locations" href="/rooms" />
        <Item
          icon={<Smartphone color={colors.violet} size={18} />}
          label="Phone requests"
          href="/requests"
          badge={overview.data?.pendingRequests ? String(overview.data.pendingRequests) : undefined}
        />
        <Item icon={<ShieldAlert color={colors.amber} size={18} />} label="Suspicious scans" href="/flags" badge={overview.data?.flaggedOpen ? String(overview.data.flaggedOpen) : undefined} />
        <Item icon={<Building2 color={colors.textMuted} size={18} />} label="Institution settings" href="/institution" last />
      </Card>

      <SectionLabel>This phone</SectionLabel>
      <Card>
        <View style={styles.row}>
          <Lock color={colors.green} size={18} />
          <Text variant="small" color={colors.text} style={{ flex: 1 }}>
            App lock on · screenshots blocked · data encrypted on the phone
          </Text>
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
