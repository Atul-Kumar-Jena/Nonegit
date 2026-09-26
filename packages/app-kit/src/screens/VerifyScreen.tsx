import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { ArrowLeft } from 'lucide-react-native';
import { Screen } from '../components/Screen';
import { OtpInput } from '../components/OtpInput';
import { Button, IconButton, Notice, Text } from '../components/ui';
import { ApiRequestError } from '../lib/api-core';
import { useSession } from '../state/session';
import { colors } from '../theme';

/** Enter the 6-digit code (step 1 of 2). */
export default function Verify() {
  const { pendingOtp, verifyOtp, requestOtp, phase } = useSession();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const submitted = useRef<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function submit(c: string) {
    if (busy || c.length !== 6 || submitted.current === c) return;
    submitted.current = c;
    setBusy(true);
    setError(null);
    try {
      const next = await verifyOtp(c);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      if (next === 'signed-in') router.replace('/home');
      else if (next === 'bind') router.replace('/bind');
      else router.replace('/mismatch');
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      setError(err instanceof Error ? err.message : 'Verification failed.');
      setCode('');
      submitted.current = null;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (code.length === 6) void submit(code);
  }, [code]);

  // No code pending (expired, or refused for this app): step back to the sign-in screen
  // rather than stacking a second one.
  useEffect(() => {
    if (pendingOtp || phase === 'signed-in') return;
    if (router.canGoBack()) router.back();
    else router.replace('/login');
  }, [pendingOtp, phase]);

  if (!pendingOtp) return null;

  const resendIn = Math.max(0, Math.ceil((pendingOtp.resendAt - now) / 1000));
  const expired = Date.parse(pendingOtp.expiresAt) <= now;

  async function resend() {
    if (!pendingOtp) return;
    setError(null);
    try {
      await requestOtp(pendingOtp.channel, pendingOtp.identifier);
      setCode('');
      submitted.current = null;
    } catch (err) {
      setError(err instanceof ApiRequestError && err.retryAfterSec ? `Please wait ${err.retryAfterSec}s before requesting another code.` : err instanceof Error ? err.message : 'Could not resend.');
    }
  }

  return (
    <Screen keyboard contentStyle={{ paddingTop: 12 }}>
      <IconButton label="Back" onPress={() => router.back()}>
        <ArrowLeft color={colors.text} size={18} />
      </IconButton>
      <Text variant="label" style={{ marginTop: 24 }}>
        Step 1 of 2
      </Text>
      <Text variant="title" style={{ marginTop: 6 }}>
        Enter the code
      </Text>
      <Text variant="body" style={{ marginTop: 6 }}>
        If <Text color={colors.text}>{pendingOtp.destination}</Text> is registered with your institution, a 6-digit code is on its way. It expires in 5 minutes. No code? Check the address or ask your admin to add you.
      </Text>
      <View style={{ marginTop: 28 }}>
        <OtpInput value={code} onChange={setCode} invalid={!!error} disabled={busy} />
      </View>
      {error ? (
        <View style={{ marginTop: 16 }}>
          <Notice message={error} tone="red" />
        </View>
      ) : null}
      {expired ? (
        <View style={{ marginTop: 16 }}>
          <Notice message="This code has expired. Request a new one." />
        </View>
      ) : null}
      <Button title="Verify" onPress={() => void submit(code)} loading={busy} disabled={code.length !== 6} style={{ marginTop: 24 }} />
      <Pressable onPress={() => void resend()} disabled={resendIn > 0} accessibilityRole="button" style={{ marginTop: 20, alignSelf: 'center' }} hitSlop={10}>
        <Text variant="small" color={resendIn > 0 ? colors.textDim : colors.cyan}>
          {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
        </Text>
      </Pressable>
    </Screen>
  );
}
