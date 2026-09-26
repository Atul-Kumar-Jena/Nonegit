import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { ArrowRight, Mail, Phone } from 'lucide-react-native';
import { EmailIdentifier, PhoneIdentifier, type Channel } from '@attendly/protocol';
import { LogoMark } from '../components/Logo';
import { Screen } from '../components/Screen';
import { Badge, Button, Input, Notice, Segmented, Text } from '../components/ui';
import { ApiRequestError } from '../lib/api-core';
import { displayHost } from '../lib/server-config';
import { useSession } from '../state/session';
import { colors } from '../theme';

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
] as const;

/** 02 · Login · OTP — institution-issued ID. */
export default function Login() {
  const { server, requestOtp, notice, clearNotice, pendingOtp, audience } = useSession();
  const [channel, setChannel] = useState<Channel>(pendingOtp?.channel === 'phone' && server?.channels.includes('phone') ? 'phone' : 'email');
  const [value, setValue] = useState(pendingOtp?.identifier ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!server) return <Redirect href="/server" />;

  async function submit() {
    setError(null);
    const parsed = channel === 'email' ? EmailIdentifier.safeParse(value) : PhoneIdentifier.safeParse(value.replace(/[\s-]/g, ''));
    if (!parsed.success) {
      setError(channel === 'email' ? 'Enter your full institution email address.' : 'Enter your number with country code, e.g. +919876543210.');
      return;
    }
    setBusy(true);
    try {
      await requestOtp(channel, parsed.data);
      router.push('/verify');
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'RATE_LIMITED' && pendingOtp && pendingOtp.identifier === parsed.data) {
        router.push('/verify'); // a code was already sent moments ago
        return;
      }
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard contentStyle={{ paddingTop: 28 }}>
      <LogoMark size={44} />
      <View style={{ gap: 6, marginTop: 22 }}>
        <Text variant="title">Sign in</Text>
        <Text variant="body">
          {audience.allowedRoles.includes('student') ? 'Use your institution-issued ID.' : `${audience.appName} — for teachers and administrators. Use the email your institution registered.`}
        </Text>
      </View>
      {notice ? (
        <View style={{ marginTop: 16 }}>
          <Notice message={notice} onDismiss={clearNotice} />
        </View>
      ) : null}
      {server.channels.includes('phone') ? (
        <View style={{ marginTop: 24 }}>
          <Segmented
            value={channel}
            options={CHANNELS}
            onChange={(c) => {
              setChannel(c);
              setValue('');
              setError(null);
            }}
          />
        </View>
      ) : null}
      <Text variant="label" style={{ marginTop: 22, marginBottom: 8 }}>
        {channel === 'email' ? 'Institution email' : 'Registered mobile number'}
      </Text>
      <Input
        value={value}
        onChangeText={(t) => {
          setValue(t);
          if (error) setError(null);
        }}
        placeholder={channel === 'email' ? 'you@iit.ac.in' : '+91 98765 43210'}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete={channel === 'email' ? 'email' : 'tel'}
        textContentType={channel === 'email' ? 'emailAddress' : 'telephoneNumber'}
        keyboardType={channel === 'email' ? 'email-address' : 'phone-pad'}
        returnKeyType="send"
        onSubmitEditing={() => void submit()}
        icon={channel === 'email' ? <Mail color={colors.textDim} size={18} /> : <Phone color={colors.textDim} size={18} />}
        invalid={!!error}
        accessibilityLabel={channel === 'email' ? 'Institution email' : 'Mobile number'}
      />
      <View style={{ marginTop: 12 }}>
        <Badge label="Verified institutions only" tone="cyan" />
      </View>
      {error ? (
        <View style={{ marginTop: 14 }}>
          <Notice message={error} tone="red" />
        </View>
      ) : null}
      <Button title="Send OTP" onPress={() => void submit()} loading={busy} disabled={!value.trim()} style={{ marginTop: 22 }} icon={<ArrowRight color="#03141c" size={18} />} />
      <Text variant="body" style={{ marginTop: 22, color: colors.text }}>
        By continuing you agree to your institution’s attendance policy and privacy terms.
      </Text>
      <Pressable onPress={() => router.push('/server')} accessibilityRole="button" style={{ marginTop: 28, alignSelf: 'flex-start' }} hitSlop={8}>
        <Text variant="monoSmall">
          Server: {displayHost(server.url)} · <Text variant="monoSmall" color={colors.cyan}>change</Text>
        </Text>
      </Pressable>
    </Screen>
  );
}
