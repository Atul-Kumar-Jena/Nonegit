import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle2, CircleAlert, FlaskConical, Power, Megaphone } from 'lucide-react-native';
import type { SwitchState } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Loading, SectionLabel, Text } from '@kit/components/ui';
import { timeAgo } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { rootApi } from '@/api';
import { qk, useConsole } from '@/queries';
import { ConfirmSheet, Header, Stat, fmtNum, fmtUptime } from '@/ui';

/** 01 Console — health, live numbers, kill switches, the latest audit events. */
export default function ConsoleScreen() {
  const q = useConsole();
  if (q.isPending)
    return (
      <Screen scroll={false}>
        <Loading label="Connecting to the console…" />
      </Screen>
    );
  if (!q.data)
    return (
      <Screen onRefresh={() => void q.refetch()}>
        <Header title="Console" subtitle="root@attendly ~ #" />
        <ErrorState message={q.error?.message ?? 'Couldn’t load the console.'} onRetry={() => void q.refetch()} />
      </Screen>
    );
  const c = q.data;
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header title="Console" subtitle={`root@attendly-${c.environment.env === 'production' ? 'prod' : c.environment.env} ~ #`} right={<Badge label={c.sandbox ? 'SANDBOX' : 'ROOT'} tone={c.sandbox ? 'amber' : 'violet'} dot={false} />} />
      {c.sandbox ? (
        <Card tone="amber" style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <FlaskConical color={colors.amber} size={18} />
          <Text variant="small" style={{ flex: 1 }}>
            Demo console: add and verify test institutions under Institutions. Platform switches are read-only here; your own developer account (Google Authenticator) controls every institution.
          </Text>
        </Card>
      ) : null}

      {c.checklist.length ? (
        <>
          <SectionLabel right={<Badge label={`${c.checklist.filter((x) => x.ok).length} / ${c.checklist.length}`} tone={c.checklist.every((x) => x.ok) ? 'green' : 'amber'} dot={false} />}>
            Production checklist
          </SectionLabel>
          <Card style={{ gap: 10 }}>
            {c.checklist.map((x) => (
              <View key={x.key} style={{ flexDirection: 'row', gap: 10 }}>
                {x.ok ? <CheckCircle2 color={colors.green} size={18} /> : <CircleAlert color={colors.amber} size={18} />}
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{x.label}</Text>
                  {x.ok ? null : <Text variant="small">{x.fix}</Text>}
                </View>
              </View>
            ))}
            <Text variant="small">{c.checklist.every((x) => x.ok) ? 'Ready for real use.' : 'Change these in Render → your service → Environment; Render restarts the server by itself.'}</Text>
          </Card>
        </>
      ) : null}

      {c.storage ? <StorageCard s={c.storage} /> : null}

      {c.push ? (
        <>
          <SectionLabel right={<Badge label={c.push.configured ? (c.push.lastError && (!c.push.lastSentAt || c.push.lastErrorAt! > c.push.lastSentAt) ? 'Failing' : 'On') : 'Off'} tone={c.push.configured ? (c.push.lastError && (!c.push.lastSentAt || c.push.lastErrorAt! > c.push.lastSentAt) ? 'red' : 'green') : 'amber'} dot={false} />}>
            Instant notifications
          </SectionLabel>
          <Card style={{ gap: 6 }}>
            {c.push.apps.length ? (
              c.push.apps.map((a) => (
                <View key={a.app} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: a.configured ? colors.green : colors.amber }} />
                  <Text variant="small" color={colors.text} style={{ flex: 1 }}>
                    {a.configured
                      ? `${a.app === 'student' ? 'Student app' : 'Institute app'} · ${a.project} · ${a.phones} ${a.phones === 1 ? 'phone' : 'phones'}`
                      : `${a.app === 'student' ? 'Student app' : 'Institute app'} · not connected: add ${a.variable} in Render → Environment`}
                  </Text>
                </View>
              ))
            ) : (
              <Text variant="small" color={colors.text}>
                {c.push.configured ? `Firebase project ${c.push.project} · ${c.push.phones} ${c.push.phones === 1 ? 'phone' : 'phones'} registered` : 'Not connected: add the Firebase service account in Render → Environment.'}
              </Text>
            )}
            {c.push.configured ? <Text variant="small">{`Since the server started: ${c.push.sent} delivered to Google · ${c.push.failed} failed · ${c.push.deadTokens} old phones forgotten${c.push.lastSentAt ? ` · last ${new Date(c.push.lastSentAt).toLocaleTimeString()}` : ''}`}</Text> : null}
            {c.push.lastError ? (
              <Text variant="small" color={colors.red}>
                {`Last error: ${c.push.lastError}`}
              </Text>
            ) : null}
            {c.push.configured && c.push.phones === 0 ? <Text variant="small">No phone has registered yet: open the Student or Institute app (a build with Firebase) and allow notifications.</Text> : null}
          </Card>
        </>
      ) : null}

      <SectionLabel right={<Badge label={c.health.db ? 'Nominal' : 'DB DOWN'} tone={c.health.db ? 'green' : 'red'} />}>{`System · ${c.environment.env}`}</SectionLabel>
      <View style={styles.grid}>
        <Stat label="Institutions" value={`${fmtNum(c.counts.tenants)}${c.counts.tenantsSuspended ? ` · ${c.counts.tenantsSuspended} off` : ''}`} />
        <Stat label="Live classes" value={fmtNum(c.counts.liveSessions)} tone={colors.cyan} />
        <Stat label="Scans / min" value={fmtNum(c.counts.scansLastMinute)} />
        <Stat label="p99 latency" value={c.health.p99Ms === null ? '—' : `${Math.round(c.health.p99Ms)} ms`} />
        <Stat label="Scans · 1 h" value={fmtNum(c.counts.scansLastHour)} />
        <Stat label="Refused · 1 h" value={`${fmtNum(c.counts.rejectionsLastHour)}${c.counts.suspiciousLastHour ? ` · ${c.counts.suspiciousLastHour} ⚠` : ''}`} tone={c.counts.suspiciousLastHour ? colors.amber : undefined} />
        <Stat label="People" value={`${fmtNum(c.counts.students)} · ${fmtNum(c.counts.staff)} staff`} />
        <Stat label="Bound phones" value={fmtNum(c.counts.activeDevices)} />
      </View>
      <Text variant="monoSmall" style={{ marginTop: 8 }}>
        up {fmtUptime(c.health.uptimeSec)} · {fmtNum(c.health.requests)} req · p50 {c.health.p50Ms ?? '—'} ms · 5xx {c.health.errors5xx} · db {c.health.dbLatencyMs ?? '—'} ms · key {c.environment.serverKeyId}
        {c.environment.demoMode ? ' · demo mode' : ''} · codes via {c.environment.otpDelivery}
      </Text>
      {c.counts.pendingDeviceRequests || c.counts.pendingCoverRequests ? (
        <Text variant="small" style={{ marginTop: 6 }}>
          Waiting: {c.counts.pendingDeviceRequests} phone changes · {c.counts.pendingCoverRequests} cover requests (handled by each institution’s admins)
        </Text>
      ) : null}

      {!c.sandbox ? (
        <Button
          title="Broadcast a message"
          kind="secondary"
          onPress={() => router.push('/broadcast')}
          icon={<Megaphone color={colors.text} size={16} />}
          style={{ marginTop: 14 }}
        />
      ) : null}

      <SectionLabel>Kill switches</SectionLabel>
      {c.sandbox ? (
        <Text variant="small" style={{ marginBottom: 8 }}>
          Read-only in the demo console. To use them, sign out and sign in with your own developer account (Developer app → First-time setup, with the setup code from your server log).
        </Text>
      ) : null}
      <Card padded={false}>
        {c.switches.map((s, i) => (
          <SwitchRow key={s.key} s={s} sandbox={c.sandbox} last={i === c.switches.length - 1} />
        ))}
      </Card>
      {!c.sandbox ? <SignOutEveryone /> : null}

      <SectionLabel right={<Button title="All" kind="ghost" compact onPress={() => router.push('/audit')} />}>Latest events</SectionLabel>
      <Card style={{ gap: 10 }}>
        {c.recent.length === 0 ? <Text variant="small">Nothing yet.</Text> : null}
        {c.recent.map((e) => (
          <View key={e.id} style={{ flexDirection: 'row', gap: 10 }}>
            <Activity color={colors.textDim} size={13} style={{ marginTop: 3 }} />
            <View style={{ flex: 1 }}>
              <Text variant="mono" numberOfLines={1}>
                {e.action}
              </Text>
              <Text variant="small" numberOfLines={1}>
                {[e.actor ?? 'system', e.tenant].filter(Boolean).join(' · ')} · {timeAgo(e.at)}
              </Text>
            </View>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

function SwitchRow({ s, sandbox, last }: { s: SwitchState; sandbox: boolean; last: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const danger = s.key !== 'demo_login_off';
  return (
    <View style={[styles.switchRow, !last && styles.divider]}>
      <Power color={s.enabled ? colors.red : colors.textDim} size={18} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong">{s.label}</Text>
        <Text variant="small">{s.detail}</Text>
        {s.updatedBy || s.reason ? (
          <Text variant="monoSmall" numberOfLines={2}>
            {s.enabled ? 'ON' : 'off'} · {s.updatedBy ?? 'system'} · {timeAgo(s.updatedAt)}
            {s.reason ? ` · “${s.reason}”` : ''}
          </Text>
        ) : null}
      </View>
      <Switch
        value={s.enabled}
        disabled={sandbox}
        onValueChange={(v) => setConfirm(v)}
        trackColor={{ true: 'rgba(248,113,113,0.5)', false: colors.border }}
        thumbColor={s.enabled ? colors.red : colors.textMuted}
        accessibilityLabel={`${s.label}: ${s.enabled ? 'on' : 'off'}`}
      />
      {confirm !== null ? (
        <ConfirmSheet
          title={`${confirm ? 'Turn on' : 'Turn off'}: ${s.label}`}
          message={confirm ? `${s.detail} This affects every institution, straight away.` : 'Everything goes back to normal for every institution.'}
          confirmText={s.key}
          action={confirm ? 'Turn on' : 'Turn off'}
          danger={confirm && danger}
          onClose={() => setConfirm(null)}
          onConfirm={async (reason, typed) => {
            await rootApi.setSwitch(api, s.key, { enabled: confirm, reason, confirm: typed });
            await qc.invalidateQueries({ queryKey: qk.console });
          }}
        />
      ) : null}
    </View>
  );
}


/** Emergency: end every login (developers' aside). Phones stay bound; people sign in again. */
function SignOutEveryone() {
  const api = useApi();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  return (
    <View style={{ marginTop: 10, gap: 8 }}>
      <Button title="Sign everyone out" kind="danger" onPress={() => setOpen(true)} icon={<Power color={colors.red} size={16} />} />
      {done ? <Text variant="small">{done}</Text> : null}
      {open ? (
        <ConfirmSheet
          title="Sign everyone out"
          message="Every student, professor and admin of every institution is signed out at once (you stay in). Their phones stay bound — they sign in again with Google Authenticator. Use it after a suspected leak."
          confirmText="sign-out-everyone"
          action="Sign everyone out"
          danger
          onClose={() => setOpen(false)}
          onConfirm={async (reason, typed) => {
            const r = await rootApi.signOutEveryone(api, { confirm: typed, reason, tenantId: null });
            setDone(`${r.signedOut} logins ended.`);
            await qc.invalidateQueries({ queryKey: qk.console });
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
});

const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

/** Data lifecycle: how big the database is, what's biggest, and what the hourly clean-up removed. */
function StorageCard({ s }: { s: NonNullable<ReturnType<typeof useConsole>['data']>['storage'] }) {
  const [open, setOpen] = useState(false);
  if (!s) return null;
  const r = s.retention;
  return (
    <>
      <SectionLabel right={<Badge label={r.lastError ? 'Clean-up failing' : mb(s.dbBytes)} tone={r.lastError ? 'red' : 'muted'} dot={false} />}>Data & storage</SectionLabel>
      <Card style={{ gap: 8 }}>
        {s.tables.slice(0, 6).map((t) => (
          <View key={t.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text variant="small" color={colors.text} style={{ flex: 1 }} numberOfLines={1}>
              {t.name}
            </Text>
            <Text variant="monoSmall">{`${fmtNum(t.rows)} rows · ${mb(t.bytes)}`}</Text>
          </View>
        ))}
        <Text variant="small" style={{ marginTop: 4 }}>
          {r.lastRunAt
            ? `Hourly clean-up · last ${timeAgo(r.lastRunAt)} · removed ${fmtNum(r.removed)} old rows in ${Math.max(1, Math.round(r.durationMs / 100) / 10)} s`
            : 'Hourly clean-up hasn’t run since the server started.'}
        </Text>
        {r.lastError ? (
          <Text variant="small" color={colors.red}>
            {`Last clean-up error: ${r.lastError}`}
          </Text>
        ) : null}
        <Button title={open ? 'Hide what is kept and for how long' : 'What is kept and for how long'} kind="ghost" compact onPress={() => setOpen((v) => !v)} />
        {open ? (
          <View style={{ gap: 6 }}>
            <Text variant="small" color={colors.text}>
              Kept for good: people, batches, courses, the timetable, every class, attendance records and credits, phones, and the tamper-evident audit log.
            </Text>
            {r.rules.map((x) => (
              <Text key={x.key} variant="small">
                {`• ${x.label}${x.removed ? ` — ${fmtNum(x.removed)} removed last run` : ''}`}
              </Text>
            ))}
          </View>
        ) : null}
      </Card>
    </>
  );
}

