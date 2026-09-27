import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { ArrowRight, FlaskConical } from 'lucide-react-native';
import { LogoMark } from '@kit/components/Logo';
import { Screen } from '@kit/components/Screen';
import { Button, Card, Notice, Text } from '@kit/components/ui';
import { useSession } from '@kit/state/session';
import { colors } from '@kit/theme';
import EmailLogin from '@kit/screens/LoginScreen';
import { openConsole } from '@/open-console';

/** Sign-in: on a demo server the console opens straight away; a real developer uses email + code. */
export default function Login() {
  const { server, requestOtp, verifyOtp } = useSession();
  const [useEmail, setUseEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dev = server?.demo?.accounts.find((a) => a.role === 'developer') ?? null;

  const open = useCallback(async () => {
    if (!dev || busy) return;
    setBusy(true);
    setError(null);
    try {
      const p = await requestOtp('email', dev.email);
      if (!p.instantCode) {
        setUseEmail(true);
        return;
      }
      openConsole.autoBind = true;
      const next = await verifyOtp(p.instantCode, p);
      if (next === 'signed-in') router.replace('/home');
      else if (next === 'bind') router.replace('/bind');
      else router.replace('/mismatch');
    } catch (err) {
      openConsole.autoBind = false;
      setError(err instanceof Error ? err.message : 'Couldn’t open the console.');
    } finally {
      setBusy(false);
    }
  }, [dev, busy, requestOtp, verifyOtp]);

  // Open by itself once per app start.
  useEffect(() => {
    if (dev && !useEmail && !openConsole.tried) {
      openConsole.tried = true;
      void open();
    }
  }, [dev, useEmail, open]);

  if (!server) return <Redirect href="/server" />;
  if (!dev || useEmail) return <EmailLogin />;

  return (
    <Screen contentStyle={{ paddingTop: 28 }}>
      <LogoMark size={30} withName />
      <View style={{ gap: 6, marginTop: 22 }}>
        <Text variant="title">Developer console</Text>
        <Text variant="body">Add institutions, verify them and watch the platform.</Text>
      </View>
      <Card tone="amber" style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: 20 }}>
        <FlaskConical color={colors.amber} size={18} />
        <Text variant="small" style={{ flex: 1 }}>
          Testing mode: no email or code needed. It closes by itself when the server’s demo mode is turned off.
        </Text>
      </Card>
      {error ? (
        <View style={{ marginTop: 14 }}>
          <Notice message={error} tone="red" />
        </View>
      ) : null}
      <Button title="Open the console" onPress={() => void open()} loading={busy} style={{ marginTop: 22 }} icon={<ArrowRight color="#0a0a0a" size={18} />} />
      {busy ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 14 }}>
          <ActivityIndicator color={colors.textDim} />
          <Text variant="small">Opening… (the first open after a quiet hour can take up to a minute)</Text>
        </View>
      ) : null}
      <Pressable onPress={() => setUseEmail(true)} accessibilityRole="button" hitSlop={8} style={{ marginTop: 26, alignSelf: 'flex-start' }}>
        <Text variant="small" color={colors.text}>
          Sign in with a developer email instead
        </Text>
      </Pressable>
    </Screen>
  );
}
