import { View } from 'react-native';
import { KeyRound, LogOut, Smartphone } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Avatar, Badge, Button, Card, ErrorState, InfoRow, Loading, SectionLabel, Text } from '@kit/components/ui';
import { initials, timeAgo } from '@kit/lib/format';
import { APP_VERSION } from '@kit/lib/env';
import { displayHost } from '@kit/lib/server-config';
import { useSession } from '@kit/state/session';
import { colors } from '@kit/theme';
import { useRootMe } from '@/queries';
import { Header } from '@/ui';

/** 05 Profile — who you are, your bound phone, the server's signing key and environment. */
export default function ProfileScreen() {
  const q = useRootMe();
  const { server, signOut } = useSession();
  if (q.isPending)
    return (
      <Screen scroll={false}>
        <Loading />
      </Screen>
    );
  if (!q.data)
    return (
      <Screen>
        <Header title="Profile" />
        <ErrorState message={q.error?.message ?? 'Couldn’t load your profile.'} onRetry={() => void q.refetch()} />
      </Screen>
    );
  const me = q.data;
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header title="Profile" subtitle="developer console" />
      <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <Avatar text={initials(me.user.name)} size={52} />
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">{me.user.name}</Text>
          <Text variant="small">{me.user.email ?? ''}</Text>
          <Text variant="small">{me.institution}</Text>
        </View>
        <Badge label={me.sandbox ? 'Sandbox' : 'Root'} tone={me.sandbox ? 'amber' : 'violet'} dot={false} />
      </Card>

      <SectionLabel>This phone</SectionLabel>
      <Card style={{ gap: 10 }}>
        {me.devices.map((d) => (
          <View key={d.fingerprint} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Smartphone color={d.status === 'active' ? colors.green : colors.textDim} size={18} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{d.model ?? d.platform}</Text>
              <Text variant="monoSmall">
                {d.fingerprint} · {d.status}
                {d.lastSeenAt ? ` · seen ${timeAgo(d.lastSeenAt)}` : ''}
              </Text>
            </View>
          </View>
        ))}
        <Text variant="small">Every request from this console is signed by this phone’s Ed25519 key, which never leaves it.</Text>
      </Card>

      <SectionLabel>Server signing key</SectionLabel>
      <Card style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <KeyRound color={colors.amber} size={16} />
          <Text variant="mono">{me.serverKey.kid}</Text>
        </View>
        <InfoRow label="FINGERPRINT" value={me.serverKey.publicKey} />
        <Text variant="small">Signs every attendance receipt. The apps pin it on first connect. Rotation is on the roadmap — it needs a signed hand-over so pinned apps accept the new key.</Text>
      </Card>

      <SectionLabel>Environment</SectionLabel>
      <Card>
        <InfoRow label="SERVER" value={server ? displayHost(server.url) : '—'} />
        <InfoRow label="MODE" value={me.environment.env} />
        <InfoRow label="SIGN-IN CODES" value={me.environment.otpDelivery} />
        <InfoRow label="DEMO MODE" value={me.environment.demoMode ? 'on (demo accounts skip codes)' : 'off'} valueColor={me.environment.demoMode ? colors.amber : undefined} />
        <InfoRow label="WEB CLIENTS" value={me.environment.webClients ? 'allowed' : 'blocked'} />
        <InfoRow label="EMULATORS" value={me.environment.emulators ? 'allowed' : 'blocked'} />
        <InfoRow label="APP" value={APP_VERSION} />
      </Card>

      <Button title="Sign out" kind="secondary" onPress={() => void signOut()} icon={<LogOut color={colors.text} size={16} />} style={{ marginTop: 18 }} />
    </Screen>
  );
}
