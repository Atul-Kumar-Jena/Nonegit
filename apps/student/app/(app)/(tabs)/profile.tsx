import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Switch, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut, RefreshCw, Server, ShieldCheck, Smartphone, Trash2 } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { SyncBanner } from '@kit/components/SyncBanner';
import { useOutbox } from '@kit/lib/outbox';
import { Avatar, Badge, Button, Card, Divider, ErrorState, IconTile, InfoRow, Input, Loading, Notice, SectionLabel, Text } from '@kit/components/ui';
import { biometricSupport, confirmWithBiometrics, type BiometricSupport } from '@kit/lib/biometrics';
import { APP_VERSION } from '@kit/lib/env';
import { dateLong, initials, timeAgo } from '@kit/lib/format';
import { loadPrefs, savePrefs } from '@kit/lib/prefs';
import { displayHost } from '@kit/lib/server-config';
import { qk, useProfile } from '@/state/queries';
import { useApi, useSession } from '@kit/state/session';
import { colors } from '@kit/theme';

/** 09 · Profile · device — bound HWID, reset, preferences. */
export default function Profile() {
  const q = useProfile();
  const api = useApi();
  const { server, signOut, resetPhone } = useSession();
  const qc = useQueryClient();
  const [bio, setBio] = useState<BiometricSupport | null>(null);
  const [bioOn, setBioOn] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const { items: unsent } = useOutbox();
  const unsentWarning = unsent.length
    ? `\n\n⚠ ${unsent.length} offline ${unsent.length === 1 ? 'scan has' : 'scans have'} not been uploaded yet and will be deleted. Connect to the internet first to keep ${unsent.length === 1 ? 'it' : 'them'}.`
    : '';

  useEffect(() => {
    void biometricSupport().then(setBio);
    void loadPrefs().then((p) => setBioOn(p.biometricForScans));
  }, []);

  const reset = useMutation({
    mutationFn: (reason: string) => api.requestDeviceReset(reason),
    onSuccess: () => {
      setResetOpen(false);
      void qc.invalidateQueries({ queryKey: qk.profile });
    },
  });

  async function toggleBio(next: boolean) {
    if (next && !(await confirmWithBiometrics(`Enable ${bio?.label ?? 'biometrics'} for scans`))) return;
    setBioOn(next);
    await savePrefs({ biometricForScans: next });
  }

  function confirm(title: string, message: string, action: string, destructive: boolean, run: () => void) {
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(`${title}\n\n${message}`)) run();
      return;
    }
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: action, style: destructive ? 'destructive' : 'default', onPress: run },
    ]);
  }

  if (q.isPending) return <Screen scroll={false}><Loading /></Screen>;
  if (q.isError && !q.data)
    return (
      <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
        <View style={{ marginTop: 40, gap: 16 }}>
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
          <Button title="Sign out" kind="secondary" onPress={() => void signOut()} />
        </View>
      </Screen>
    );

  const p = q.data!;
  const u = p.user;
  const rr = p.resetRequests;
  const limitReached = rr.used >= rr.limit;
  const sub = [u.rollNo, u.department, u.semester ? `Sem ${u.semester}` : null].filter(Boolean).join(' · ');

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Text variant="label" style={{ marginTop: 4 }}>
        Account
      </Text>
      <Text variant="title" style={{ marginTop: 4 }}>
        Profile
      </Text>

      <Card style={styles.idCard}>
        <Avatar text={initials(u.fullName)} size={68} />
        <Text variant="heading" style={{ marginTop: 14, fontSize: 19 }}>
          {u.fullName}
        </Text>
        {sub ? (
          <Text variant="monoSmall" style={{ marginTop: 4 }}>
            {sub}
          </Text>
        ) : null}
        <Text variant="small" style={{ marginTop: 2 }}>
          {u.institution.name}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Badge label="Verified" tone="cyan" icon={<ShieldCheck color={colors.cyan} size={11} />} />
          <Badge label="Active" tone="green" />
        </View>
      </Card>

      <SectionLabel>Bound device</SectionLabel>
      <Card>
        <View style={styles.row}>
          <IconTile tone="cyan">
            <Smartphone color={colors.cyan} size={18} />
          </IconTile>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">{p.device.model}</Text>
            <Text variant="monoSmall">
              {p.device.osVersion} · HWID {p.device.fingerprint}
            </Text>
          </View>
          <Badge label="Bound" tone="green" />
        </View>
        <Divider style={{ marginVertical: 12 }} />
        <InfoRow label="Bound on" value={p.device.boundAt ? dateLong(p.device.boundAt) : '—'} />
        <InfoRow label="Last scan" value={timeAgo(p.lastScanAt)} />
        <InfoRow label="Reset requests" value={`${rr.used} / ${rr.limit} this term`} valueColor={limitReached ? colors.amber : undefined} />
      </Card>

      {rr.pending ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="cyan" message={`Reset requested ${timeAgo(rr.pending.createdAt)} — waiting for your admin. Reason: “${rr.pending.reason}”`} />
        </View>
      ) : (
        <Button
          title={limitReached ? 'Reset limit reached this term' : 'Request device reset'}
          kind="danger"
          disabled={limitReached}
          onPress={() => setResetOpen(true)}
          icon={<RefreshCw color={colors.red} size={16} />}
          style={{ marginTop: 12 }}
        />
      )}

      <SyncBanner />

      <SectionLabel>Preferences</SectionLabel>
      <Card>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">Biometric unlock</Text>
            <Text variant="small">{bio?.available ? `${bio.label} before every scan` : 'Not set up on this device'}</Text>
          </View>
          <Switch
            value={bioOn}
            disabled={!bio?.available}
            onValueChange={(v) => void toggleBio(v)}
            trackColor={{ true: colors.cyan, false: colors.borderHi }}
            thumbColor="#ffffff"
            ios_backgroundColor={colors.borderHi}
            accessibilityLabel="Require biometrics before scanning"
          />
        </View>
      </Card>

      <SectionLabel>App</SectionLabel>
      <Card>
        <View style={styles.row}>
          <IconTile tone="violet">
            <Server color="#a78bfa" size={17} />
          </IconTile>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">{server ? displayHost(server.url) : '—'}</Text>
            <Text variant="monoSmall">Pinned key {server?.kid ?? '—'}</Text>
          </View>
        </View>
        <Divider style={{ marginVertical: 12 }} />
        <InfoRow label="App version" value={APP_VERSION} />
      </Card>

      <View style={{ gap: 10, marginTop: 16 }}>
        <Button
          title="Sign out"
          kind="secondary"
          icon={<LogOut color={colors.text} size={16} />}
          onPress={() => confirm('Sign out?', `This phone stays bound to your account — you can sign back in any time with a new code.${unsentWarning}`, 'Sign out', unsent.length > 0, () => void signOut())}
        />
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            confirm(
              'Erase this phone’s identity?',
              `This permanently deletes the device key. To use Attendly on this phone again, your admin must approve a new binding. Only do this if you are giving the phone away.${unsentWarning}`,
              'Erase',
              true,
              () => void resetPhone(),
            )
          }
          style={styles.erase}
          hitSlop={8}
        >
          <Trash2 color={colors.textDim} size={14} />
          <Text variant="small" color={colors.textDim}>
            Erase device identity
          </Text>
        </Pressable>
      </View>

      <ResetSheet
        open={resetOpen}
        busy={reset.isPending}
        error={reset.error?.message ?? null}
        onClose={() => {
          setResetOpen(false);
          reset.reset();
        }}
        onSubmit={(r) => reset.mutate(r)}
      />
    </Screen>
  );
}

function ResetSheet({ open, busy, error, onClose, onSubmit }: { open: boolean; busy: boolean; error: string | null; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text variant="heading">Request device reset</Text>
        <Text variant="small" style={{ marginTop: 6 }}>
          Your admin will unbind this phone so you can bind a new one. Until then, this phone keeps working.
        </Text>
        <View style={{ marginTop: 14 }}>
          <Input value={reason} onChangeText={setReason} placeholder="Reason, e.g. switching to a new phone" maxLength={200} autoFocus />
        </View>
        {error ? (
          <View style={{ marginTop: 10 }}>
            <Notice tone="red" message={error} />
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <Button title="Cancel" kind="secondary" onPress={onClose} style={{ flex: 1 }} />
          <Button title="Send request" onPress={() => onSubmit(reason.trim())} loading={busy} disabled={reason.trim().length < 3} style={{ flex: 1 }} />
        </View>
      </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  idCard: { alignItems: 'center', paddingVertical: 22, marginTop: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  erase: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, padding: 20, paddingBottom: 36 },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderHi, marginBottom: 16 },
});
