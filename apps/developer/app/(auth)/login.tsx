import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { FlaskConical, KeyRound, Mail } from 'lucide-react-native';
import { EmailIdentifier } from '@attendly/protocol';
import { LogoMark } from '@kit/components/Logo';
import { OtpInput } from '@kit/components/OtpInput';
import { Screen } from '@kit/components/Screen';
import { Card, Input, Notice, Text } from '@kit/components/ui';
import { ApiRequestError } from '@kit/lib/api-core';
import { lastSignInId, rememberSignInId } from '@kit/lib/sign-in-id';
import { useSession, type PendingOtp } from '@kit/state/session';
import { colors } from '@kit/theme';
import EmailLogin from '@kit/screens/LoginScreen';

/**
 * The developer signs in with Google Authenticator: their ID (remembered on this phone) and the
 * app's 6-digit code. The very first time, "First-time setup" links the authenticator with the
 * setup code printed in the server log.
 */
export default function Login() {
  const { server, requestOtp, verifyOtp, notice, clearNotice } = useSession();
  const [id, setId] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState<PendingOtp | null>(null);
  const [busy, setBusy] = useState<'code' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useEmail, setUseEmail] = useState(false);
  const demoDev = server?.demo?.accounts.find((a) => a.role === 'developer') ?? null;

  useEffect(() => {
    void lastSignInId().then((v) => v && setId((cur) => cur || v));
  }, []);

  // Six digits typed: sign in.
  useEffect(() => {
    if (code.length === 6 && !busy) void signIn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (!server) return <Redirect href="/server" />;
  if (useEmail) return <EmailLogin />;

  function go(next: 'signed-in' | 'bind' | 'mismatch') {
    router.replace(next === 'signed-in' ? '/home' : next === 'bind' ? '/bind' : '/mismatch');
  }

  async function signIn() {
    setError(null);
    clearNotice();
    const parsed = EmailIdentifier.safeParse(id);
    if (!parsed.success) {
      setError('Enter your developer sign-in ID (an email address).');
      setCode('');
      return;
    }
    setBusy('code');
    try {
      // One challenge takes several tries; ask for a new one only when it's gone.
      let p = pending && pending.identifier === parsed.data && Date.parse(pending.expiresAt) > Date.now() + 5_000 ? pending : null;
      if (!p) {
        p = await requestOtp('email', parsed.data);
        setPending(p);
      }
      if (p.method !== 'authenticator') {
        setError('This account hasn’t linked Google Authenticator yet. Use “First-time setup” below with the setup code from the server log.');
        setCode('');
        return;
      }
      const next = await verifyOtp(code, p);
      await rememberSignInId(parsed.data);
      go(next);
    } catch (err) {
      if (err instanceof ApiRequestError && (err.code === 'OTP_EXPIRED' || err.code === 'OTP_LOCKED')) setPending(null);
      setError(err instanceof Error ? err.message : 'Couldn’t sign in.');
      setCode('');
    } finally {
      setBusy(null);
    }
  }

  async function demo() {
    if (!demoDev || busy) return;
    setError(null);
    setBusy('demo');
    try {
      const p = await requestOtp('email', demoDev.email);
      if (!p.instantCode) throw new Error('The demo console isn’t available on this server.');
      go(await verifyOtp(p.instantCode, p));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t open the demo console.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen keyboard contentStyle={{ paddingTop: 28 }}>
      <LogoMark size={30} withName />
      <View style={{ gap: 6, marginTop: 22 }}>
        <Text variant="title">Developer console</Text>
        <Text variant="body">Sign in with Google Authenticator. Only this console registers institutions.</Text>
      </View>
      {notice ? (
        <View style={{ marginTop: 16 }}>
          <Notice message={notice} onDismiss={clearNotice} />
        </View>
      ) : null}
      <Text variant="label" style={{ marginTop: 22, marginBottom: 8 }}>
        Sign-in ID
      </Text>
      <Input
        value={id}
        onChangeText={(t) => {
          setId(t);
          setPending(null);
          if (error) setError(null);
        }}
        placeholder="developer@attendly.app"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        icon={<Mail color={colors.textDim} size={18} />}
        accessibilityLabel="Developer sign-in ID"
      />
      <Text variant="label" style={{ marginTop: 18, marginBottom: 8 }}>
        Code from Google Authenticator
      </Text>
      <OtpInput value={code} onChange={setCode} invalid={!!error} disabled={!!busy} />
      {busy === 'code' ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <ActivityIndicator color={colors.textDim} />
          <Text variant="small">Signing in… (the first sign-in after a quiet hour can take up to a minute)</Text>
        </View>
      ) : null}
      {error ? (
        <View style={{ marginTop: 14 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}

      <Pressable onPress={() => router.push('/setup')} accessibilityRole="button" style={{ marginTop: 22 }}>
        <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          <KeyRound color={colors.text} size={18} />
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">First-time setup</Text>
            <Text variant="small">Link Google Authenticator once with the setup code from the server log.</Text>
          </View>
        </Card>
      </Pressable>

      {demoDev ? (
        <Pressable onPress={() => void demo()} accessibilityRole="button" style={{ marginTop: 10 }} disabled={!!busy}>
          <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <FlaskConical color={colors.amber} size={18} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">Try the demo console</Text>
              <Text variant="small">Sandbox with the demo institute — no setup needed.</Text>
            </View>
            {busy === 'demo' ? <ActivityIndicator color={colors.textDim} /> : null}
          </Card>
        </Pressable>
      ) : null}

      <Pressable onPress={() => setUseEmail(true)} accessibilityRole="button" hitSlop={8} style={{ marginTop: 22, alignSelf: 'flex-start' }}>
        <Text variant="small" color={colors.text}>
          Sign in with an emailed code instead
        </Text>
      </Pressable>
    </Screen>
  );
}
