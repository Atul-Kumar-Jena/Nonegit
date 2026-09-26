import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Pause, Play, ShieldCheck } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, InfoRow, Loading, SectionLabel, Text } from '@kit/components/ui';
import { timeAgo } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { rootApi } from '@/api';
import { useConsole, useTenant } from '@/queries';
import { ConfirmSheet, Header, fmtNum } from '@/ui';

/** One institution: numbers, admins, flags, recent events; suspend / resume. */
export default function TenantScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const q = useTenant(String(id));
  const me = useConsole();
  const [confirm, setConfirm] = useState(false);
  if (q.isPending)
    return (
      <Screen scroll={false}>
        <Header title="Institution" back />
        <Loading />
      </Screen>
    );
  if (!q.data)
    return (
      <Screen>
        <Header title="Institution" back />
        <ErrorState message={q.error?.message ?? 'Not found.'} onRetry={() => void q.refetch()} />
      </Screen>
    );
  const t = q.data;
  const suspending = t.status === 'active';
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header title={t.name} subtitle={`tenant:${t.slug}`} back right={<Badge label={t.status === 'active' ? 'Active' : 'Suspended'} tone={t.status === 'active' ? 'green' : 'red'} />} />
      {t.statusReason ? (
        <Card tone="red">
          <Text variant="small">Suspended: {t.statusReason}</Text>
        </Card>
      ) : null}
      <Card style={{ marginTop: 10 }}>
        <InfoRow label="STUDENTS" value={fmtNum(t.students)} />
        <InfoRow label="TEACHERS" value={fmtNum(t.teachers)} />
        <InfoRow label="ADMINS" value={fmtNum(t.admins.length)} />
        <InfoRow label="LIVE NOW" value={String(t.liveSessions)} />
        <InfoRow label="SCANS · 24 H" value={fmtNum(t.scansToday)} />
        <InfoRow label="MIN ATTENDANCE" value={`${t.minAttendance}%`} />
        <InfoRow label="TIME ZONE" value={t.timezone} />
        <InfoRow label="EMAIL DOMAINS" value={t.emailDomains.join(', ') || '—'} />
        <InfoRow label="CREATED" value={new Date(t.createdAt).toDateString()} />
      </Card>

      <SectionLabel>Admins</SectionLabel>
      <Card style={{ gap: 8 }}>
        {t.admins.length === 0 ? <Text variant="small">No admin yet.</Text> : null}
        {t.admins.map((a) => (
          <View key={a.id}>
            <Text variant="bodyStrong">{a.name}</Text>
            <Text variant="small">
              {a.email ?? '—'}
              {a.status !== 'active' ? ` · ${a.status}` : ''}
            </Text>
          </View>
        ))}
      </Card>

      <SectionLabel>Feature flags</SectionLabel>
      <Card style={{ gap: 4 }}>
        {t.flags.map((f) => (
          <Text key={f.key} variant="mono">
            {f.enabled ? '●' : '○'} {f.key}
          </Text>
        ))}
        <Text variant="small">Change them on the Flags tab.</Text>
      </Card>

      <SectionLabel>Recent events</SectionLabel>
      <Card style={{ gap: 8 }}>
        {t.recent.map((e) => (
          <View key={e.id}>
            <Text variant="mono" numberOfLines={1}>
              {e.action}
            </Text>
            <Text variant="small">
              {e.actor ?? 'system'} · {timeAgo(e.at)}
            </Text>
          </View>
        ))}
      </Card>

      <Button
        title={suspending ? 'Suspend institution' : 'Resume institution'}
        kind={suspending ? 'danger' : 'primary'}
        onPress={() => setConfirm(true)}
        icon={suspending ? <Pause color={colors.red} size={16} /> : <Play color="#03141c" size={16} />}
        style={{ marginTop: 18 }}
      />
      <Text variant="small" style={{ marginTop: 8 }}>
        {suspending ? 'Suspending signs everyone there out at once and blocks sign-ins and scans until you resume. Nothing is deleted.' : 'Resuming lets everyone sign in again.'}
        {me.data?.sandbox ? ' (Sandbox: you can’t suspend the demo institute you are signed in to.)' : ''}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
        <ShieldCheck color={colors.textDim} size={13} />
        <Text variant="small">Every change here is written to the audit log with your reason.</Text>
      </View>

      {confirm ? (
        <ConfirmSheet
          title={suspending ? `Suspend ${t.name}` : `Resume ${t.name}`}
          message={suspending ? `All ${fmtNum(t.students + t.teachers + t.admins.length)} people at ${t.name} are signed out now and can’t sign in or mark attendance until you resume.` : `${t.name} goes back to normal.`}
          confirmText={t.slug}
          action={suspending ? 'Suspend' : 'Resume'}
          danger={suspending}
          onClose={() => setConfirm(false)}
          onConfirm={async (reason, typed) => {
            await rootApi.setTenantStatus(api, t.id, { status: suspending ? 'suspended' : 'active', reason, confirm: typed });
            await qc.invalidateQueries({ queryKey: ['root'] });
          }}
        />
      ) : null}
    </Screen>
  );
}
