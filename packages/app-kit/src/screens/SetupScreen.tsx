import { useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { ArrowLeft, ExternalLink, KeyRound, ShieldCheck, Smartphone } from 'lucide-react-native';
import { formatSetupCode, normalizeSetupCode, type SetupStartResponse } from '@attendly/protocol';
import { LogoMark } from '../components/Logo';
import { OtpInput } from '../components/OtpInput';
import { QrCode } from '../components/QrCode';
import { Screen } from '../components/Screen';
import { Button, Card, IconButton, Input, Notice, Text } from '../components/ui';
import { rememberSignInId } from '../lib/sign-in-id';
import { useSession } from '../state/session';
import { colors } from '../theme';

/** "abcdefgh jkmn" → "ABCD-EFGH-JKMN" as it is typed. */
function tidyCode(t: string): string {
  const c = t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  return c.replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * First sign-in with a setup code (no email): link Google Authenticator once, then this phone is
 * bound as usual. From then on the person signs in with their ID and the authenticator's code.
 */
export default function SetupScreen() {
  const { server, needsInstitution, institution, startSetup, finishSetup, verifyOtp, audience } = useSession();
  const [id, setId] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [setup, setSetup] = useState<SetupStartResponse | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Six digits typed: finish straight away.
  useEffect(() => {
    if (setup && code.length === 6 && !busy) void finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (!server) return <Redirect href="/server" />;
  if (needsInstitution) return <Redirect href="/institution-code" />;

  const cleanId = id.trim();
  const usable = cleanId.length >= 3 && normalizeSetupCode(setupCode) !== null;

  async function start() {
    setError(null);
    setBusy(true);
    try {
      setSetup(await startSetup(cleanId, setupCode));
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t check the setup code.');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setError(null);
    setBusy(true);
    try {
      const p = await finishSetup(cleanId, setupCode, code);
      if (!p.instantCode) throw new Error('Please try again.');
      const next = await verifyOtp(p.instantCode, p);
      await rememberSignInId(cleanId);
      if (next === 'signed-in') router.replace('/home');
      else if (next === 'bind') router.replace('/bind');
      else router.replace('/mismatch');
    } catch (err) {
      setCode('');
      setError(err instanceof Error ? err.message : 'That didn’t work. Try the newest code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard contentStyle={{ paddingTop: 20 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconButton onPress={() => (setup ? setSetup(null) : router.back())} label="Back">
          <ArrowLeft color={colors.text} size={20} />
        </IconButton>
        <LogoMark size={26} withName />
      </View>
      <Text variant="title" style={{ marginTop: 20 }}>
        First sign-in
      </Text>

      {!setup ? (
        <>
          <Text variant="body" style={{ marginTop: 8 }}>
            {audience.appName === 'Attendly Developer'
              ? 'On render.com open your Attendly service → Logs and search “first-time setup”. That line shows your sign-in ID and your setup code (the same code at every restart until you use it). You link Google Authenticator once; after that you sign in with its code.'
              : `Enter the setup code you were given${institution ? ` by ${institution.name}` : ''}. You link Google Authenticator once; after that you sign in with its code — no email needed.`}
          </Text>
          <Text variant="label" style={{ marginTop: 22, marginBottom: 8 }}>
            Your sign-in ID
          </Text>
          <Input
            value={id}
            onChangeText={(t) => {
              setId(t);
              if (error) setError(null);
            }}
            placeholder="the email or mobile number you were registered with"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            icon={<Smartphone color={colors.textDim} size={18} />}
            accessibilityLabel="Sign-in ID"
          />
          <Text variant="label" style={{ marginTop: 16, marginBottom: 8 }}>
            Setup code
          </Text>
          <Input
            value={setupCode}
            onChangeText={(t) => {
              setSetupCode(tidyCode(t));
              if (error) setError(null);
            }}
            placeholder="ABCD-EFGH-JKMN"
            autoCapitalize="characters"
            autoCorrect={false}
            icon={<KeyRound color={colors.textDim} size={18} />}
            accessibilityLabel="Setup code"
            onSubmitEditing={() => usable && void start()}
          />
          {error ? (
            <View style={{ marginTop: 14 }}>
              <Notice tone="red" message={error} />
            </View>
          ) : null}
          <Button title="Continue" onPress={() => void start()} loading={busy} disabled={!usable} style={{ marginTop: 22 }} />
          <Text variant="small" style={{ marginTop: 16 }}>
            {audience.appName === 'Attendly Developer'
              ? 'Use the sign-in ID exactly as the log line shows it (e.g. developer@attendly.app), not your personal email.'
              : 'No setup code? Ask your institution’s admin for one. Each code works once and expires after a few days.'}
          </Text>
        </>
      ) : (
        <View style={{ gap: 14, marginTop: 10 }}>
          <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <ShieldCheck color={colors.green} size={20} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{setup.name}</Text>
              <Text variant="small">{`${setup.institution} · ${setup.account}`}</Text>
            </View>
          </Card>
          <Text variant="label">1 · Add Attendly to Google Authenticator</Text>
          <Button
            title="Open Google Authenticator"
            onPress={() => void Linking.openURL(setup.otpauthUrl).catch(() => setError('Google Authenticator isn’t installed. Install it from the Play Store, or type the key below into any authenticator app.'))}
            icon={<ExternalLink color={colors.bg} size={16} />}
          />
          <Card style={{ gap: 6 }}>
            <Text variant="small">Or in the app choose “+ → Enter a setup key” and type:</Text>
            <Text variant="mono" selectable style={{ letterSpacing: 1.5 }}>
              {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
            </Text>
            <Text variant="small">{`Account: ${setup.account} · Time-based`}</Text>
          </Card>
          <Text variant="small">Adding it on another phone? Scan this there:</Text>
          <View style={{ alignItems: 'center' }}>
            <QrCode value={setup.otpauthUrl} size={180} />
          </View>
          <Text variant="label">2 · Type the 6-digit code it shows</Text>
          <OtpInput value={code} onChange={setCode} invalid={!!error} disabled={busy} />
          {error ? <Notice tone="red" message={error} /> : null}
          <Button title="Finish" onPress={() => void finish()} loading={busy} disabled={code.length !== 6} />
          <Pressable onPress={() => setSetup(null)} accessibilityRole="button" hitSlop={8} style={{ alignSelf: 'flex-start' }}>
            <Text variant="small" color={colors.text}>{`Setup code ${formatSetupCode(normalizeSetupCode(setupCode) ?? '')} — change`}</Text>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}
