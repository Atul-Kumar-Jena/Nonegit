import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Globe, Lock } from 'lucide-react-native';
import { LogoMark } from '@/components/Logo';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, Input, Notice, Text } from '@/components/ui';
import { ServerIdentityError, displayHost } from '@/lib/server-config';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

/** Choose the Attendly server (your institution's deployment). */
export default function ServerSetup() {
  const { connect, suggestedServerUrl, server, notice, clearNotice } = useSession();
  const [url, setUrl] = useState(suggestedServerUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    clearNotice();
    setBusy(true);
    try {
      await connect(url);
      router.replace('/login');
    } catch (err) {
      setError(err instanceof ServerIdentityError || err instanceof Error ? err.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard contentStyle={{ paddingTop: 28, gap: 14 }}>
      <LogoMark size={44} />
      <View style={{ gap: 6, marginTop: 8 }}>
        <Text variant="title">Connect to your institution</Text>
        <Text variant="body">Paste the address of your Attendly server — exactly as it was shown when the server was set up.</Text>
      </View>
      {notice ? <Notice message={notice} onDismiss={clearNotice} /> : null}
      <Text variant="label" style={{ marginTop: 6 }}>
        Server address
      </Text>
      <Input
        value={url}
        onChangeText={setUrl}
        placeholder="https://attendly-api-xxxx.onrender.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        icon={<Globe color={colors.textDim} size={18} />}
        invalid={!!error}
        accessibilityLabel="Server address"
      />
      {error ? <Notice message={error} tone="red" /> : null}
      <Button title="Connect" onPress={() => void submit()} loading={busy} disabled={!url.trim()} />
      {busy ? (
        <Text variant="small" style={{ textAlign: 'center' }}>
          Connecting… a free server that was asleep can take up to a minute to wake up.
        </Text>
      ) : null}
      <Card style={{ gap: 8, marginTop: 8 }}>
        <Badge label="Pinned on first connect" tone="violet" icon={<Lock color="#a78bfa" size={11} />} />
        <Text variant="small">
          The app remembers this server’s cryptographic identity. If it ever changes, Attendly stops and warns you instead of sending your attendance anywhere else.
        </Text>
        {server ? <Text variant="monoSmall">Current: {displayHost(server.url)} · {server.kid}</Text> : null}
      </Card>
    </Screen>
  );
}
