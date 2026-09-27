import { useState } from 'react';
import { Share, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Pause, Play, RefreshCw, Share2, ShieldCheck, Users } from 'lucide-react-native';
import { formatInstitutionCode, type IssuedSetupCode } from '@attendly/protocol';
import { SetupCodeCard } from '@kit/components/SetupCodeCard';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, InfoRow, Loading, Notice, SectionLabel, Text } from '@kit/components/ui';
import { timeAgo } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { rootApi } from '@/api';
import { useConsole, useTenant } from '@/queries';
import { ConfirmSheet, Header, fmtNum } from '@/ui';

/** One institution: numbers, admins, flags, recent events; suspend / resume. */
export default function TenantScreen() {
  const params = useLocalSearchParams<{ id: string; setup?: string; sid?: string; nm?: string; exp?: string }>();
  const id = params.id;
  // Just created: the main admin's setup code arrives with the navigation (shown once).
  const [issued, setIssued] = useState<IssuedSetupCode | null>(
    params.setup && params.sid && params.nm && params.exp ? { code: String(params.setup), signInId: String(params.sid), name: String(params.nm), expiresAt: String(params.exp) } : null,
  );
  const api = useApi();
  const qc = useQueryClient();
  const q = useTenant(String(id));
  const me = useConsole();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'verify' | 'code' | 'setup' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function run(kind: 'verify' | 'code' | 'setup', f: () => Promise<unknown>) {
    if (busy) return;
    setBusy(kind);
    setErr(null);
    try {
      await f();
      await qc.invalidateQueries({ queryKey: ['root'] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed.');
    } finally {
      setBusy(null);
    }
  }
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
      <Card tone={t.verified ? 'green' : 'amber'} style={{ marginTop: 10, gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <BadgeCheck color={t.verified ? colors.green : colors.amber} size={18} />
          <Text variant="bodyStrong" style={{ flex: 1 }}>
            {t.verified ? `Verified${t.verifiedAt ? ` · ${new Date(t.verifiedAt).toDateString()}` : ''}` : 'Pending verification — nobody can sign in yet'}
          </Text>
        </View>
        <View>
          <Text variant="label">Institution code</Text>
          <Text style={{ fontFamily: fonts.monoMedium, fontSize: 28, letterSpacing: 3, color: colors.text, marginTop: 4 }} selectable>
            {formatInstitutionCode(t.code)}
          </Text>
          <Text variant="small">Staff type this once in Attendly Institute, then sign in with Google Authenticator.</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button
            title={t.verified ? 'Remove verification' : 'Verify institution'}
            kind={t.verified ? 'secondary' : 'primary'}
            compact
            loading={busy === 'verify'}
            onPress={() => void run('verify', () => rootApi.verifyTenant(api, t.id, !t.verified))}
            style={{ flex: 1 }}
          />
          <Button
            title="Share"
            kind="secondary"
            compact
            onPress={() =>
              void Share.share({ message: `${t.name} on Attendly\nInstitution code: ${formatInstitutionCode(t.code)}\nInstall Attendly Institute and enter this code. First time: tap “Sign in with a setup code” (your admin gives you one).` }).catch(() => undefined)
            }
            icon={<Share2 color={colors.text} size={15} />}
          />
          <Button title="New" kind="ghost" compact loading={busy === 'code'} onPress={() => void run('code', () => rootApi.newTenantCode(api, t.id))} icon={<RefreshCw color={colors.text} size={14} />} />
        </View>
        {err ? <Notice tone="red" message={err} /> : null}
      </Card>
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

      <Button
        title="Manage people"
        kind="secondary"
        onPress={() => router.push({ pathname: '/tenant/people', params: { id: t.id, name: t.name } })}
        icon={<Users color={colors.text} size={16} />}
        style={{ marginTop: 12 }}
      />

      <SectionLabel>Admins</SectionLabel>
      {issued ? (
        <View style={{ marginBottom: 10 }}>
          <SetupCodeCard issued={issued} app="Attendly Institute" institution={t.name} institutionCode={t.code} onDone={() => setIssued(null)} />
          {!t.verified ? <Text variant="small" style={{ marginTop: 6 }}>Verify the institution first — nobody can sign in before that.</Text> : null}
        </View>
      ) : null}
      <Card style={{ gap: 10 }}>
        {t.admins.length === 0 ? <Text variant="small">No admin yet.</Text> : null}
        {t.admins.map((a) => (
          <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{a.name}</Text>
              <Text variant="small">
                {a.email ?? '—'}
                {a.status !== 'active' ? ` · ${a.status}` : ''}
              </Text>
            </View>
            {a.owner ? <Badge label="Main admin" tone="violet" dot={false} /> : null}
            <Badge label={a.authenticator ? 'Authenticator ✓' : 'Not set up'} tone={a.authenticator ? 'green' : 'amber'} dot={false} />
          </View>
        ))}
        <Text variant="small">The main admin adds the other admins and professors in Attendly Institute.</Text>
        {t.admins.some((a) => a.owner) ? (
          <Button
            title="New setup code for the main admin"
            kind="secondary"
            compact
            loading={busy === 'setup'}
            onPress={() => void run('setup', async () => setIssued(await rootApi.adminSetup(api, t.id)))}
            icon={<RefreshCw color={colors.text} size={14} />}
          />
        ) : null}
        <Text variant="small">Use it when they’re setting up a new phone: their old phone and old code stop working.</Text>
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
