import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { ArrowRight, BadgeCheck, Building2, KeyRound, Mail, Phone } from 'lucide-react-native';
import { EmailIdentifier, PhoneIdentifier, formatInstitutionCode, type Channel } from '@attendly/protocol';
import { LogoMark } from '../components/Logo';
import { Screen } from '../components/Screen';
import { Button, Card, Input, Notice, Segmented, Text } from '../components/ui';
import { ApiRequestError } from '../lib/api-core';
import { useSession } from '../state/session';
import { colors, fonts } from '../theme';

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
] as const;

/** 02 · Login · OTP — institution-issued ID. */
export default function Login() {
  const { server, requestOtp, verifyOtp, notice, clearNotice, pendingOtp, audience, institution, needsInstitution, setInstitution } = useSession();
  const [demoBusy, setDemoBusy] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>(pendingOtp?.channel === 'phone' && server?.channels.includes('phone') ? 'phone' : 'email');
  const [value, setValue] = useState(pendingOtp?.identifier ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!server) return <Redirect href="/server" />;
  if (needsInstitution) return <Redirect href="/institution-code" />;

  async function submit() {
    setError(null);
    const parsed = channel === 'email' ? EmailIdentifier.safeParse(value) : PhoneIdentifier.safeParse(value.replace(/[\s-]/g, ''));
    if (!parsed.success) {
      setError(channel === 'email' ? 'Enter your full institution email address.' : 'Enter your number with country code, e.g. +919876543210.');
      return;
    }
    setBusy(true);
    try {
      const p = await requestOtp(channel, parsed.data);
      if (p.instantCode) {
        go(await verifyOtp(p.instantCode, p));
        return;
      }
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

  function go(next: 'signed-in' | 'bind' | 'mismatch') {
    if (next === 'signed-in') router.replace('/home');
    else if (next === 'bind') router.replace('/bind');
    else router.replace('/mismatch');
  }

  /** Demo server: one tap signs in as a demo account (no code needed). */
  async function demoSignIn(email: string) {
    if (demoBusy) return;
    setError(null);
    clearNotice();
    setDemoBusy(email);
    try {
      const p = await requestOtp('email', email);
      if (!p.instantCode) {
        router.push('/verify');
        return;
      }
      go(await verifyOtp(p.instantCode, p));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setDemoBusy(null);
    }
  }

  // With an institution chosen, only that institution's demo accounts make sense.
  const demoAccounts = (server.demo?.accounts ?? []).filter(
    (a) => audience.allowedRoles.includes(a.role) && (!audience.institutionGate || institution?.code === server.demo?.institutionCode),
  );

  return (
    <Screen keyboard contentStyle={{ paddingTop: 28 }}>
      {/* Long-press the logo to see or change the server (for IT staff; nobody else needs it). */}
      <Pressable onLongPress={() => router.push('/server')} delayLongPress={1200} accessibilityLabel={audience.appName} style={{ alignSelf: 'flex-start' }}>
        <LogoMark size={30} withName />
      </Pressable>
      <View style={{ gap: 6, marginTop: 22 }}>
        <Text variant="title">Sign in</Text>
        <Text variant="body">
          {audience.allowedRoles.includes('student')
            ? 'Use the email your institution gave you — the one on your college records.'
            : `${audience.appName} is for professors and admins. Use the email your institution registered for you.`}
        </Text>
      </View>
      {audience.institutionGate && institution ? (
        <Card style={{ marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Building2 color={colors.text} size={20} />
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong" numberOfLines={2}>
              {institution.name}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
              <BadgeCheck color={colors.green} size={14} />
              <Text variant="small">{`Verified · ${formatInstitutionCode(institution.code)}`}</Text>
            </View>
          </View>
          <Pressable onPress={() => void setInstitution(null).then(() => router.replace('/institution-code'))} accessibilityRole="button" hitSlop={8}>
            <Text variant="small" color={colors.text}>
              Change
            </Text>
          </Pressable>
        </Card>
      ) : null}
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
        {channel === 'email' ? 'Your institution email' : 'Your registered mobile number'}
      </Text>
      <Input
        value={value}
        onChangeText={(t) => {
          setValue(t);
          if (error) setError(null);
        }}
        placeholder={channel === 'email' ? 'name@yourcollege.edu' : '+91 98765 43210'}
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
      {error ? (
        <View style={{ marginTop: 14 }}>
          <Notice message={error} tone="red" />
        </View>
      ) : null}
      <Button title="Continue" onPress={() => void submit()} loading={busy} disabled={!value.trim()} style={{ marginTop: 20 }} icon={<ArrowRight color={colors.ink} size={18} />} />

      {/* What really happens, in three plain steps. */}
      <Card style={{ marginTop: 22, gap: 12 }}>
        <Text variant="label">How signing in works</Text>
        {[
          ['1', 'Your institution email', 'The address your college registered for you — not a personal one, unless that’s the one they have.'],
          ['2', 'A 6-digit code', 'From Google Authenticator once you’ve linked it; until then it’s emailed to you.'],
          ['3', 'This phone becomes yours', 'Your account works on this one phone. Changing phones needs your institution’s OK.'],
        ].map(([n, title, text]) => (
          <View key={n} style={{ flexDirection: 'row', gap: 12 }}>
            <View style={styles.step}>
              <Text style={styles.stepText}>{n}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong" style={{ fontSize: 14 }}>
                {title}
              </Text>
              <Text variant="small">{text}</Text>
            </View>
          </View>
        ))}
      </Card>

      <Pressable onPress={() => router.push('/setup')} accessibilityRole="button" style={({ pressed }) => [styles.firstTime, pressed && { backgroundColor: colors.cardHi }]}>
        <KeyRound color={colors.text} size={18} />
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong" style={{ fontSize: 14 }}>
            First time? Use your setup code
          </Text>
          <Text variant="small">Got a code from your admin? Link Google Authenticator in a minute — no email needed after that.</Text>
        </View>
        <ArrowRight color={colors.textDim} size={16} />
      </Pressable>
      {demoAccounts.length ? (
        <View style={{ marginTop: 26, gap: 8 }}>
          <Text variant="label">Demo accounts{server.demo?.institution ? ` · ${server.demo.institution}` : ''}</Text>
          <Text variant="small">Tap one to sign in straight away — no code needed on this demo server.</Text>
          {demoAccounts.map((a) => (
            <Pressable
              key={a.email}
              onPress={() => void demoSignIn(a.email)}
              disabled={!!demoBusy}
              accessibilityRole="button"
              accessibilityLabel={`Sign in as ${a.name}, ${a.title}`}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                padding: 12,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: pressed ? colors.cardHi : colors.card,
                opacity: demoBusy && demoBusy !== a.email ? 0.5 : 1,
              })}
            >
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong">{a.name}</Text>
                <Text variant="small">{a.title}</Text>
                <Text variant="monoSmall">{a.email}</Text>
              </View>
              {demoBusy === a.email ? <ActivityIndicator color={colors.cyan} /> : <ArrowRight color={colors.textDim} size={18} />}
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text variant="small" style={{ marginTop: 22 }}>
        By continuing you agree to your institution’s attendance policy and privacy terms.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  step: { width: 26, height: 26, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.borderHi },
  stepText: { fontFamily: fonts.bold, fontSize: 12, color: colors.text },
  firstTime: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.borderHi, backgroundColor: colors.card },
});
