import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import { authenticate } from '@kit/lib/biometrics';
import { ArrowLeft, Fingerprint, X } from 'lucide-react-native';
import { Button, IconButton, Input, Notice, Text } from '@kit/components/ui';
import { colors, fonts } from '@kit/theme';

export function Header({ title, subtitle, right, back }: { title: string; subtitle?: string; right?: ReactNode; back?: boolean }) {
  return (
    <View style={styles.header}>
      {back ? (
        <IconButton label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}>
          <ArrowLeft color={colors.text} size={18} />
        </IconButton>
      ) : null}
      <View style={{ flex: 1 }}>
        {subtitle ? <Text style={styles.prompt}>{subtitle}</Text> : null}
        <Text variant="title" numberOfLines={1}>
          {title}
        </Text>
      </View>
      {right}
    </View>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const sheetInsets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: 24 + sheetInsets.bottom }]}>
          <View style={styles.grabber} />
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text variant="heading" style={{ flex: 1 }}>
              {title}
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10}>
              <X color={colors.textMuted} size={20} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Fingerprint / face / device PIN before a risky action (skipped where there's no biometric hardware, e.g. web). */
export async function confirmIdentity(prompt: string): Promise<boolean> {
  if (Platform.OS === 'web') return true;
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return true;
    const r = await authenticate({ promptMessage: prompt, cancelLabel: 'Cancel', disableDeviceFallback: false });
    return r.success;
  } catch {
    return false;
  }
}

/**
 * Two-step confirmation for anything that affects real people: type the exact name,
 * give a reason (it goes in the audit log), then prove it's you.
 */
export function ConfirmSheet({
  title,
  message,
  confirmText,
  action,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmText: string;
  action: string;
  danger?: boolean;
  onConfirm: (reason: string, typed: string) => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setError(null);
    if (!(await confirmIdentity(title))) {
      setError('Not confirmed — nothing was changed.');
      return;
    }
    setBusy(true);
    try {
      await onConfirm(reason.trim(), typed.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open onClose={onClose} title={title}>
      <Text variant="body">{message}</Text>
      <Text variant="label" style={{ marginTop: 16, marginBottom: 8 }}>
        Reason (saved in the audit log)
      </Text>
      <Input value={reason} onChangeText={setReason} placeholder="e.g. Incident #42: fake-GPS wave" maxLength={300} />
      <Text variant="label" style={{ marginTop: 16, marginBottom: 8 }}>
        Type <Text style={styles.code}>{confirmText}</Text> to confirm
      </Text>
      <Input value={typed} onChangeText={setTyped} autoCapitalize="none" autoCorrect={false} placeholder={confirmText} />
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      <Button
        title={action}
        kind={danger ? 'danger' : 'primary'}
        onPress={() => void go()}
        loading={busy}
        disabled={typed.trim() !== confirmText || reason.trim().length < 3}
        icon={<Fingerprint color={danger ? colors.red : '#03141c'} size={16} />}
        style={{ marginTop: 16 }}
      />
    </Sheet>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.stat}>
      <Text variant="label" numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.statValue, tone ? { color: tone } : null]}>{value}</Text>
    </View>
  );
}

export const fmtNum = (n: number) => n.toLocaleString('en-IN');
export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4, marginBottom: 14 },
  prompt: { fontFamily: fonts.mono, fontSize: 12, color: colors.violet },
  code: { fontFamily: fonts.mono, color: colors.cyan },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, padding: 20, paddingBottom: 36, maxHeight: '88%' },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderHi, marginBottom: 14 },
  stat: { flexBasis: '47%', flexGrow: 1, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, gap: 4 },
  statValue: { fontFamily: fonts.display, fontSize: 22, color: colors.text },
});
