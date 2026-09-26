import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Clock } from 'lucide-react-native';
import type { TenantFlagKey } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Card, ErrorState, Loading, Notice, SectionLabel, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { rootApi } from '@/api';
import { qk, useFlags } from '@/queries';
import { Header, confirmIdentity } from '@/ui';

/** 03 Feature flags — per institution, all enforced by the server; the roadmap below. */
export default function FlagsScreen() {
  const api = useApi();
  const qc = useQueryClient();
  const q = useFlags();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(tenantId: string, key: TenantFlagKey, enabled: boolean) {
    setError(null);
    if (!(await confirmIdentity('Change a feature flag'))) return;
    setBusy(`${tenantId}:${key}`);
    try {
      await rootApi.setFlag(api, { tenantId, key, enabled });
      await qc.invalidateQueries({ queryKey: qk.flags });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t change the flag.');
    } finally {
      setBusy(null);
    }
  }

  if (q.isPending)
    return (
      <Screen scroll={false}>
        <Loading />
      </Screen>
    );
  if (!q.data)
    return (
      <Screen>
        <Header title="Feature flags" />
        <ErrorState message={q.error?.message ?? 'Couldn’t load flags.'} onRetry={() => void q.refetch()} />
      </Screen>
    );
  const { definitions, planned, tenants } = q.data;
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header title="Feature flags" subtitle="per institution · enforced server-side" right={<Badge label={String(definitions.length)} tone="violet" dot={false} />} />
      {error ? <Notice tone="red" message={error} /> : null}
      <Card style={{ gap: 6 }}>
        {definitions.map((d) => (
          <Text key={d.key} variant="small">
            <Text variant="mono">{d.key}</Text> — {d.detail} (default {d.default ? 'on' : 'off'})
          </Text>
        ))}
      </Card>

      {tenants.map((t) => (
        <View key={t.id}>
          <SectionLabel>{t.name}</SectionLabel>
          <Card padded={false}>
            {definitions.map((d, i) => {
              const on = t.flags[d.key] ?? d.default;
              return (
                <View key={d.key} style={[styles.row, i < definitions.length - 1 && styles.divider]}>
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong">{d.label}</Text>
                    <Text variant="monoSmall">{d.key}</Text>
                  </View>
                  <Switch
                    value={on}
                    disabled={busy === `${t.id}:${d.key}`}
                    onValueChange={(v) => void toggle(t.id, d.key as TenantFlagKey, v)}
                    trackColor={{ true: 'rgba(139,92,246,0.55)', false: colors.border }}
                    thumbColor={on ? colors.violet : colors.textMuted}
                    accessibilityLabel={`${d.label} for ${t.name}`}
                  />
                </View>
              );
            })}
          </Card>
        </View>
      ))}

      <SectionLabel>Planned (not switchable yet)</SectionLabel>
      <Card padded={false}>
        {planned.map((p, i) => (
          <View key={p.key} style={[styles.row, i < planned.length - 1 && styles.divider, { opacity: 0.7 }]}>
            <Clock color={colors.textDim} size={16} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{p.label}</Text>
              <Text variant="small">{p.detail}</Text>
            </View>
            <Badge label="Planned" tone="muted" dot={false} />
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
});
