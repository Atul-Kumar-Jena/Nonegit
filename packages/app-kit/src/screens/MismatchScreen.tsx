import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { Clock, Smartphone, SmartphoneNfc } from 'lucide-react-native';
import { Screen } from '../components/Screen';
import { Badge, Button, Card, IconTile, Input, Notice, Text } from '../components/ui';
import { dateLong } from '../lib/format';
import { useSession } from '../state/session';
import { colors, fonts, radius } from '../theme';

const REASONS = ['Lost previous phone', 'Phone replaced / upgraded', 'Phone broken or stolen'];

/** The account is bound to another phone: request an admin-approved switch. */
export default function Mismatch() {
  const { pendingDevice, requestRebind, signOut } = useSession();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (pendingDevice?.kind !== 'mismatch') return <Redirect href="/login" />;
  const pending = !!pendingDevice.pendingRequest || sent;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await requestRebind(reason.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard contentStyle={{ paddingTop: 20 }}>
      <Text variant="label">Device check</Text>
      <Text variant="title" style={{ marginTop: 6 }}>
        Your account is bound to another phone
      </Text>
      <Text variant="body" style={{ marginTop: 8 }}>
        For attendance to be unforgeable, each student can mark only from one bound phone.
      </Text>

      <Card style={[styles.row, { marginTop: 20 }]}>
        <IconTile tone="muted">
          <Smartphone color={colors.textMuted} size={18} />
        </IconTile>
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">{pendingDevice.boundDevice.model}</Text>
          <Text variant="monoSmall">
            HWID {pendingDevice.boundDevice.fingerprint}
            {pendingDevice.boundDevice.boundAt ? ` · since ${dateLong(pendingDevice.boundDevice.boundAt)}` : ''}
          </Text>
        </View>
        <Badge label="Bound" tone="green" />
      </Card>

      {pending ? (
        <Card tone="cyan" style={{ marginTop: 16, gap: 10 }}>
          <View style={styles.row}>
            <IconTile tone="cyan">
              <Clock color={colors.cyan} size={18} />
            </IconTile>
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">Switch requested</Text>
              <Text variant="small">Your institution admin will review it. Once approved, sign in again on this phone.</Text>
            </View>
          </View>
        </Card>
      ) : (
        <>
          <Text variant="label" style={{ marginTop: 26, marginBottom: 10 }}>
            Request to use this phone instead
          </Text>
          <View style={styles.chips}>
            {REASONS.map((r) => (
              <Pressable key={r} onPress={() => setReason(r)} accessibilityRole="button" accessibilityState={{ selected: reason === r }} style={[styles.chip, reason === r && styles.chipOn]}>
                <Text style={[styles.chipText, reason === r && { color: colors.text }]}>{r}</Text>
              </Pressable>
            ))}
          </View>
          <Input value={reason} onChangeText={setReason} placeholder="Or describe what happened" maxLength={200} icon={<SmartphoneNfc color={colors.textDim} size={18} />} />
          {error ? (
            <View style={{ marginTop: 12 }}>
              <Notice message={error} tone="red" />
            </View>
          ) : null}
          <Button title="Request device switch" onPress={() => void submit()} loading={busy} disabled={reason.trim().length < 3} style={{ marginTop: 18 }} />
        </>
      )}
      <Button
        title="Back to sign in"
        kind="ghost"
        onPress={() => {
          void signOut();
          router.replace('/login');
        }}
        style={{ marginTop: 8 }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  chip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 8 },
  chipOn: { borderColor: 'rgba(34,211,238,0.45)', backgroundColor: 'rgba(34,211,238,0.08)' },
  chipText: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
});
