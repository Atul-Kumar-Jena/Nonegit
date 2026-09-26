import { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, KeyRound, ShieldCheck } from 'lucide-react-native';
import { AuthenticatorSetup, AuthenticatorStatus } from '@attendly/protocol';
import { OtpInput } from '../components/OtpInput';
import { QrCode } from '../components/QrCode';
import { Screen } from '../components/Screen';
import { Badge, Button, Card, IconButton, Loading, Notice, Text } from '../components/ui';
import { useSession } from '../state/session';
import { colors } from '../theme';

const KEY = ['authenticator'] as const;

/** Sign-in security: switch sign-in codes to Google Authenticator (or turn it off). */
export default function SecurityScreen() {
  const { api } = useSession();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: KEY, queryFn: () => api!.authed('GET', '/v1/me/authenticator', AuthenticatorStatus), enabled: !!api });
  const [setup, setSetup] = useState<AuthenticatorSetup | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));

  async function start() {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      setSetup(await api!.authed('POST', '/v1/me/authenticator/setup', AuthenticatorSetup, {}));
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t start the setup.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(c: string) {
    if (c.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = disabling ? '/v1/me/authenticator/disable' : '/v1/me/authenticator/confirm';
      const s = await api!.authed('POST', path, AuthenticatorStatus, { code: c });
      qc.setQueryData(KEY, s);
      setDone(s.enabled ? 'Done. From now on, sign in with the code from your authenticator app.' : 'Turned off. Sign-in codes come by email again.');
      setSetup(null);
      setDisabling(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code didn’t work.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (code.length === 6) void submit(code);
  }, [code]);

  const enabled = status.data?.enabled ?? false;
  return (
    <Screen keyboard>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconButton label="Back" onPress={back}>
          <ArrowLeft color={colors.text} size={18} />
        </IconButton>
        <Text variant="heading" style={{ flex: 1 }}>
          Sign-in security
        </Text>
      </View>

      <Text variant="title" style={{ marginTop: 24 }}>
        Authenticator app
      </Text>
      <Text variant="body" style={{ marginTop: 6 }}>
        Use Google Authenticator (or Microsoft Authenticator, Authy…) for your sign-in codes instead of email. Codes work offline and change every 30 seconds.
      </Text>

      {status.isPending ? <Loading /> : null}
      {status.data ? (
        <Card style={{ marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <ShieldCheck color={enabled ? colors.green : colors.textDim} size={22} />
          <Text variant="bodyStrong" style={{ flex: 1 }}>
            {enabled ? 'On — sign in with the app’s code' : 'Off — codes come by email'}
          </Text>
          <Badge label={enabled ? 'On' : 'Off'} tone={enabled ? 'green' : 'muted'} dot={false} />
        </Card>
      ) : null}
      {done ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="green" message={done} />
        </View>
      ) : null}
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}

      {setup ? (
        <View style={{ marginTop: 20, gap: 14 }}>
          <Text variant="label">1 · Add Attendly to the app</Text>
          <Button title="Open in Google Authenticator" onPress={() => void Linking.openURL(setup.otpauthUrl).catch(() => setError('No authenticator app found. Install Google Authenticator, or type the key below into it.'))} icon={<ExternalLink color={colors.bg} size={16} />} />
          <Card style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <KeyRound color={colors.textDim} size={14} />
              <Text variant="small">Or choose “Enter a setup key” in the app:</Text>
            </View>
            <Text variant="mono" selectable style={{ letterSpacing: 1.5 }}>
              {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
            </Text>
            <Text variant="small">Account: {setup.account} · Time-based</Text>
          </Card>
          <Text variant="small">Setting it up for this phone from another one? Scan this:</Text>
          <View style={{ alignItems: 'center' }}>
            <QrCode value={setup.otpauthUrl} size={200} />
          </View>
          <Text variant="label">2 · Type the code the app shows</Text>
          <OtpInput value={code} onChange={setCode} invalid={!!error} disabled={busy} />
          <Button title="Cancel" kind="ghost" onPress={() => setSetup(null)} />
        </View>
      ) : disabling ? (
        <View style={{ marginTop: 20, gap: 14 }}>
          <Text variant="label">Type a current code from the app to turn it off</Text>
          <OtpInput value={code} onChange={setCode} invalid={!!error} disabled={busy} />
          <Button title="Keep it on" kind="ghost" onPress={() => setDisabling(false)} />
        </View>
      ) : status.data ? (
        enabled ? (
          <Button
            title="Turn off"
            kind="secondary"
            onPress={() => {
              setDisabling(true);
              setCode('');
              setDone(null);
            }}
            style={{ marginTop: 20 }}
          />
        ) : (
          <Button title="Set up Google Authenticator" onPress={() => void start()} loading={busy} style={{ marginTop: 20 }} />
        )
      ) : null}

      <Text variant="small" style={{ marginTop: 24 }}>
        Lost the phone with the authenticator? Your admin can reset it (Institute app → People → you → Authenticator).
      </Text>
    </Screen>
  );
}
