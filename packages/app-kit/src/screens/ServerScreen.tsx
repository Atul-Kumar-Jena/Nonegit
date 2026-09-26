import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Globe, Lock, RefreshCw } from 'lucide-react-native';
import { LogoMark } from '../components/Logo';
import { Screen } from '../components/Screen';
import { Badge, Button, Card, Input, Notice, Text } from '../components/ui';
import { DEFAULT_SERVER_URL } from '../lib/env';
import { ServerIdentityError, displayHost } from '../lib/server-config';
import { useSession } from '../state/session';
import { colors } from '../theme';

/**
 * Connects to the Attendly server. The address is built into the app, so on first launch
 * this screen connects by itself (waiting for a sleeping free server to wake up) — typing
 * an address is only needed for a different deployment.
 */
export default function ServerSetup() {
  const { connect, suggestedServerUrl, server, notice, clearNotice } = useSession();
  const [manual, setManual] = useState(!!server || !DEFAULT_SERVER_URL);
  const [url, setUrl] = useState(suggestedServerUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const tryConnect = useCallback(
    async (address: string) => {
      setError(null);
      clearNotice();
      setBusy(true);
      try {
        await connect(address);
        if (alive.current) router.replace('/login');
        return true;
      } catch (err) {
        if (alive.current) setError(err instanceof ServerIdentityError || err instanceof Error ? err.message : 'Could not connect.');
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [connect, clearNotice],
  );

  // Built-in server: connect automatically, retrying a few times while it wakes up.
  useEffect(() => {
    if (manual || !DEFAULT_SERVER_URL) return;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < 3 && !cancelled && alive.current; i++) {
        setAttempt(i + 1);
        if (await tryConnect(DEFAULT_SERVER_URL)) return;
        await new Promise((r) => setTimeout(r, 4000));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manual, tryConnect]);

  if (!manual)
    return (
      <Screen contentStyle={{ paddingTop: 28, gap: 14 }}>
        <LogoMark size={44} />
        <View style={{ gap: 6, marginTop: 8 }}>
          <Text variant="title">Connecting to Attendly</Text>
          <Text variant="body">{displayHost(DEFAULT_SERVER_URL)}</Text>
        </View>
        {busy ? (
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <ActivityIndicator color={colors.cyan} />
            <Text variant="small" style={{ flex: 1 }}>
              {attempt > 1 ? `Still waking the server up (try ${attempt} of 3)…` : 'Connecting… if the server was asleep this takes up to a minute.'}
            </Text>
          </Card>
        ) : null}
        {error && !busy ? (
          <>
            <Notice message={error} tone="red" />
            <Button title="Try again" onPress={() => void tryConnect(DEFAULT_SERVER_URL)} icon={<RefreshCw color="#03141c" size={16} />} />
          </>
        ) : null}
        {notice ? <Notice message={notice} onDismiss={clearNotice} /> : null}
        <Pressable onPress={() => setManual(true)} accessibilityRole="button" hitSlop={8} style={{ alignSelf: 'flex-start', marginTop: 12 }}>
          <Text variant="small" color={colors.cyan}>
            Use a different server
          </Text>
        </Pressable>
      </Screen>
    );

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
        onSubmitEditing={() => void tryConnect(url)}
        icon={<Globe color={colors.textDim} size={18} />}
        invalid={!!error}
        accessibilityLabel="Server address"
      />
      {error ? <Notice message={error} tone="red" /> : null}
      <Button title="Connect" onPress={() => void tryConnect(url)} loading={busy} disabled={!url.trim()} />
      {busy ? (
        <Text variant="small" style={{ textAlign: 'center' }}>
          Connecting… a free server that was asleep can take up to a minute to wake up.
        </Text>
      ) : null}
      {DEFAULT_SERVER_URL && url.trim() !== DEFAULT_SERVER_URL ? (
        <Pressable onPress={() => setUrl(DEFAULT_SERVER_URL)} accessibilityRole="button" hitSlop={8} style={{ alignSelf: 'flex-start' }}>
          <Text variant="small" color={colors.cyan}>
            Use the built-in server ({displayHost(DEFAULT_SERVER_URL)})
          </Text>
        </Pressable>
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
