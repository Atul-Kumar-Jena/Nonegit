import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { Fingerprint, KeyRound, Smartphone } from 'lucide-react-native';
import { keyFingerprint } from '@attendly/protocol';
import { Screen } from '../components/Screen';
import { Badge, Button, Card, IconTile, Notice, Text } from '../components/ui';
import { biometricSupport, confirmWithBiometrics } from '../lib/biometrics';
import { collectDeviceInfo } from '../lib/device-info';
import { deviceKeys } from '../lib/device-key';
import { useSession } from '../state/session';
import { colors } from '../theme';

/** 03 · Device binding — one person, one phone (step 2 of 2). */
export default function Bind() {
  const { pendingDevice, bindDevice } = useSession();
  const [device, setDevice] = useState<{ model: string; os: string; fingerprint: string; rooted: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [info, pk] = await Promise.all([collectDeviceInfo(), deviceKeys.publicKey()]);
      if (alive) setDevice({ model: info.model, os: info.osVersion, fingerprint: keyFingerprint(pk), rooted: info.integrity.rooted });
    })().catch(() => alive && setError('Could not read this device’s secure key store.'));
    return () => {
      alive = false;
    };
  }, []);

  if (pendingDevice?.kind !== 'bind') return <Redirect href="/login" />;

  async function bind() {
    setBusy(true);
    setError(null);
    try {
      const bio = await biometricSupport();
      if (bio.available && !(await confirmWithBiometrics('Confirm to bind this phone to your account'))) {
        setError('Binding cancelled.');
        return;
      }
      await bindDevice();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      router.replace('/home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Binding failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen contentStyle={{ paddingTop: 20 }}>
      <Text variant="label">Step 2 of 2</Text>
      <Text variant="title" style={{ marginTop: 6 }}>
        Bind this device
      </Text>

      <Card style={styles.hero} padded={false}>
        <LinearGradient colors={['rgba(255, 255, 255, 0.14)', 'rgba(255, 255, 255, 0)']} start={{ x: 0.5, y: 0.5 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />
        <View style={[styles.ring, { width: 180, height: 180 }]} />
        <View style={[styles.ring, { width: 132, height: 132, borderColor: 'rgba(255, 255, 255, 0.22)' }]} />
        <View style={styles.core}>
          <Fingerprint color={colors.cyan} size={34} strokeWidth={1.8} />
        </View>
      </Card>

      <Text variant="heading" style={{ marginTop: 22, fontSize: 19 }}>
        One person, one device.
      </Text>
      <Text variant="body" style={{ marginTop: 8 }}>
        We’ll bind {pendingDevice.user.rollNo ? `roll number ${pendingDevice.user.rollNo}` : 'your account'} to this phone’s cryptographic key. Switching devices later requires admin approval.
      </Text>

      <View style={{ gap: 10, marginTop: 20 }}>
        <Card style={styles.row}>
          <IconTile tone="green">
            <Smartphone color={colors.green} size={18} />
          </IconTile>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">{device ? `${device.model} · ${device.os}` : 'Reading device…'}</Text>
            <Text variant="monoSmall">HWID {device?.fingerprint ?? '····-····-····'}</Text>
          </View>
          {device ? device.rooted ? <Badge label="Rooted" tone="red" /> : <Badge label="Integrity OK" tone="green" /> : null}
        </Card>
        <Card style={styles.row}>
          <IconTile tone="violet">
            <KeyRound color="#d4d4d4" size={18} />
          </IconTile>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">Ed25519 device key</Text>
            <Text variant="monoSmall">Generated on this phone · never leaves it</Text>
          </View>
          <Badge label="Sealed" tone="violet" />
        </Card>
      </View>

      {error ? (
        <View style={{ marginTop: 16 }}>
          <Notice message={error} tone="red" />
        </View>
      ) : null}
      <Button title="Bind this device" onPress={() => void bind()} loading={busy} disabled={!device || device.rooted} style={{ marginTop: 22 }} />
      <Text variant="small" style={{ marginTop: 12, textAlign: 'center' }}>
        Signed in as {pendingDevice.user.fullName} · {pendingDevice.user.institution.name}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { height: 220, marginTop: 20, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  ring: { position: 'absolute', borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.12)' },
  core: {
    width: 76,
    height: 76,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ffffff',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 0 },
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
