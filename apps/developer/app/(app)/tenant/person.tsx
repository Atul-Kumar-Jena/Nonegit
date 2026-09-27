import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, Crown, GraduationCap, KeyRound, ShieldCheck, Smartphone } from 'lucide-react-native';
import type { IssuedSetupCode, SupportAction } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { SetupCodeCard } from '@kit/components/SetupCodeCard';
import { Avatar, Badge, Button, Card, ErrorState, InfoRow, Input, Loading, Notice, SectionLabel, Segmented, Text } from '@kit/components/ui';
import { dateLong, initials, timeAgo } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { rootApi } from '@/api';
import { setAttribution, useAttribution } from '@/attribution';
import { Header, confirmIdentity } from '@/ui';

const LABEL: Record<SupportAction, string> = {
  suspend: 'Suspend account',
  reactivate: 'Reactivate account',
  reset_phone: 'Unlink their phone',
  setup_code: 'New setup code',
  make_admin: 'Make admin',
  make_professor: 'Make professor',
  make_owner: 'Make main admin',
};

/** Support: one person of an institution — their account, phone, attendance and history, and actions. */
export default function SupportPersonScreen() {
  const { tid, pid } = useLocalSearchParams<{ tid: string; pid: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const as = useAttribution();
  const q = useQuery({ queryKey: ['root', 'person', tid, pid], queryFn: () => rootApi.person(api, String(tid), String(pid)) });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<SupportAction | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<IssuedSetupCode | null>(null);

  if (q.isPending)
    return (
      <Screen scroll={false}>
        <Header title="Person" back />
        <Loading />
      </Screen>
    );
  if (!q.data)
    return (
      <Screen>
        <Header title="Person" back />
        <ErrorState message={q.error?.message ?? 'Not found.'} onRetry={() => void q.refetch()} />
      </Screen>
    );
  const { person: p, attendance, history } = q.data;

  async function run(action: SupportAction) {
    setError(null);
    setDone(null);
    if (reason.trim().length < 3) {
      setError('Write a short reason first — it goes on the record.');
      return;
    }
    if (!(await confirmIdentity(LABEL[action]))) return;
    setBusy(action);
    try {
      const r = await rootApi.act(api, String(tid), String(pid), { action, as, reason: reason.trim() });
      setDone(r.message);
      if (r.setup) setSetup(r.setup);
      qc.setQueryData(['root', 'person', tid, pid], { ...q.data!, person: r.person });
      void qc.invalidateQueries({ queryKey: ['root'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That didn’t work.');
    } finally {
      setBusy(null);
    }
  }

  const staff = p.role === 'teacher' || p.role === 'admin';
  const actions: { key: SupportAction; icon: React.ReactNode; danger?: boolean; show: boolean }[] = [
    { key: 'reset_phone', icon: <Smartphone color={colors.text} size={16} />, show: !!p.device },
    { key: 'setup_code', icon: <KeyRound color={colors.text} size={16} />, show: p.status === 'active' },
    { key: 'make_admin', icon: <ShieldCheck color={colors.text} size={16} />, show: p.role === 'teacher' },
    { key: 'make_professor', icon: <GraduationCap color={colors.text} size={16} />, show: p.role === 'admin' && !p.owner },
    { key: 'make_owner', icon: <Crown color={colors.text} size={16} />, show: p.role === 'admin' && !p.owner },
    { key: 'reactivate', icon: <CheckCircle2 color={colors.text} size={16} />, show: p.status === 'suspended' },
    { key: 'suspend', icon: <Ban color={colors.red} size={16} />, danger: true, show: p.status === 'active' && !p.owner },
  ];

  return (
    <Screen keyboard>
      <Header title={p.fullName} subtitle={p.owner ? 'Main admin' : p.role === 'admin' ? 'Admin' : p.role === 'teacher' ? 'Professor' : 'Student'} back />
      <Card style={{ alignItems: 'center', gap: 8, paddingVertical: 20 }}>
        <Avatar text={initials(p.fullName)} size={56} />
        <Text variant="bodyStrong">{p.fullName}</Text>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Badge label={p.status === 'active' ? 'Active' : 'Suspended'} tone={p.status === 'active' ? 'green' : 'red'} />
          {p.authenticator ? <Badge label="Google Authenticator" tone="muted" dot={false} /> : p.setupPending ? <Badge label="Setup code given" tone="amber" dot={false} /> : null}
        </View>
      </Card>

      <SectionLabel>Account</SectionLabel>
      <Card>
        <InfoRow label="EMAIL" value={p.email ?? '—'} />
        <InfoRow label="PHONE" value={p.phone ?? '—'} />
        {p.rollNo ? <InfoRow label="ROLL NO." value={p.rollNo} /> : null}
        {p.department ? <InfoRow label="DEPARTMENT" value={p.department} /> : null}
        <InfoRow label="LINKED PHONE" value={p.device ? `${p.device.model}${p.device.hardware !== 'none' ? ' · security chip' : ''}` : 'none'} />
        {p.device?.boundAt ? <InfoRow label="LINKED ON" value={dateLong(p.device.boundAt)} /> : null}
        {attendance ? <InfoRow label="ATTENDANCE" value={attendance.percent === null ? 'no classes yet' : `${attendance.percent}% · ${attendance.attended} of ${attendance.held}`} /> : null}
        {staff && p.permissions.length ? <InfoRow label="EXTRA POWERS" value={p.permissions.join(', ')} /> : null}
      </Card>

      <SectionLabel>Act on this account</SectionLabel>
      <Card style={{ gap: 12 }}>
        <Text variant="label">They see this as done by</Text>
        <Segmented
          value={as}
          options={[
            { value: 'named', label: 'My name' },
            { value: 'support', label: 'Attendly support' },
          ]}
          onChange={setAttribution}
        />
        <Text variant="small">Either way it’s recorded in the audit log under your account, with the reason.</Text>
        <Input value={reason} onChangeText={setReason} placeholder="Reason (e.g. lost phone, ticket #42)" maxLength={200} />
        {actions
          .filter((a) => a.show)
          .map((a) => (
            <Button key={a.key} title={LABEL[a.key]} kind={a.danger ? 'danger' : 'secondary'} loading={busy === a.key} onPress={() => void run(a.key)} icon={a.icon} />
          ))}
        {error ? <Notice tone="red" message={error} onDismiss={() => setError(null)} /> : null}
        {done ? <Notice tone="green" message={done} onDismiss={() => setDone(null)} /> : null}
      </Card>
      {setup ? (
        <View style={{ marginTop: 12 }}>
          <SetupCodeCard issued={setup} app={p.role === 'student' ? 'Attendly' : 'Attendly Institute'} onDone={() => setSetup(null)} />
        </View>
      ) : null}

      <SectionLabel>History</SectionLabel>
      <Card style={{ gap: 10 }}>
        {history.length === 0 ? <Text variant="small">Nothing recorded yet.</Text> : null}
        {history.map((e) => (
          <View key={e.id}>
            <Text variant="mono" numberOfLines={1}>
              {e.action}
            </Text>
            <Text variant="small" numberOfLines={1}>
              {`${e.actor ?? 'system'} · ${timeAgo(e.at)}`}
            </Text>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
