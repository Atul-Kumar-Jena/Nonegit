import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle2, CircleAlert, FlaskConical, Power } from 'lucide-react-native';
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
            Demo sandbox: you see only the demo institute, and platform switches are read-only. A real developer account controls every institution.
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

      <SectionLabel>Kill switches</SectionLabel>
      <Card padded={false}>
        {c.switches.map((s, i) => (
          <SwitchRow key={s.key} s={s} sandbox={c.sandbox} last={i === c.switches.length - 1} />
        ))}
      </Card>

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


const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
});
