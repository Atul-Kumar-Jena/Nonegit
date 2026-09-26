import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ShieldCheck, ShieldX } from 'lucide-react-native';
import { AUDIT_CATEGORIES, type AuditCategory, type AuditEntry, type AuditVerification } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Loading, Notice, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { rootApi } from '@/api';
import { useAudit } from '@/queries';
import { Header, fmtNum } from '@/ui';

const LABEL: Record<AuditCategory, string> = { all: 'All', auth: 'Auth', scans: 'Scans', admin: 'Admin', crypto: 'Crypto' };

/** 02 Audit — the append-only, hash-chained log of everything that happened. */
export default function AuditScreen() {
  const api = useApi();
  const [cat, setCat] = useState<AuditCategory>('all');
  const q = useAudit(cat);
  const [open, setOpen] = useState<number | null>(null);
  const [verify, setVerify] = useState<AuditVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const total = q.data?.pages[0]?.total;

  async function runVerify() {
    setVerifying(true);
    setError(null);
    try {
      setVerify(await rootApi.verifyAudit(api));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setVerifying(false);
    }
  }

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header title="Audit" subtitle="immutable log · hash-chained" right={total !== undefined ? <Badge label={fmtNum(total)} tone="violet" dot={false} /> : undefined} />
      <View style={styles.chips}>
        {AUDIT_CATEGORIES.map((c) => (
          <Pressable key={c} onPress={() => setCat(c)} accessibilityRole="radio" accessibilityState={{ selected: cat === c }} style={[styles.chip, cat === c && styles.chipOn]}>
            <Text variant="small" color={cat === c ? colors.text : colors.textMuted}>
              {LABEL[c]}
            </Text>
          </Pressable>
        ))}
      </View>
      <Button title="Verify the whole chain" kind="secondary" compact onPress={() => void runVerify()} loading={verifying} icon={<ShieldCheck color={colors.text} size={15} />} style={{ marginTop: 12, alignSelf: 'flex-start' }} />
      {verify ? (
        <Card tone={verify.ok ? 'green' : 'red'} style={{ marginTop: 10, flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          {verify.ok ? <ShieldCheck color={colors.green} size={20} /> : <ShieldX color={colors.red} size={20} />}
          <Text variant="small" style={{ flex: 1 }}>
            {verify.message}
          </Text>
        </Card>
      ) : null}
      {error ? <Notice tone="red" message={error} /> : null}

      <View style={{ gap: 8, marginTop: 14 }}>
        {q.isPending ? <Loading /> : null}
        {q.isError ? <ErrorState message={q.error.message} onRetry={() => void q.refetch()} /> : null}
        {entries.map((e) => (
          <Row key={e.id} e={e} open={open === e.id} onPress={() => setOpen(open === e.id ? null : e.id)} />
        ))}
        {q.hasNextPage ? <Button title="Older" kind="ghost" onPress={() => void q.fetchNextPage()} loading={q.isFetchingNextPage} /> : null}
        {!q.isPending && entries.length === 0 ? <Text variant="small">No events in this category.</Text> : null}
      </View>
    </Screen>
  );
}

function Row({ e, open, onPress }: { e: AuditEntry; open: boolean; onPress: () => void }) {
  const when = new Date(e.at);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${e.action} by ${e.actor ?? 'system'}`}>
      <Card style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Text variant="monoSmall">{`${when.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${when.toTimeString().slice(0, 8)}`}</Text>
          <Text variant="mono" style={{ flex: 1, color: colorOf(e.category) }} numberOfLines={1}>
            {e.action}
          </Text>
        </View>
        <Text variant="small" numberOfLines={open ? undefined : 1}>
          {e.actor ?? 'system'} → {e.subject ?? '—'}
          {e.tenant ? ` · ${e.tenant}` : ' · platform'}
        </Text>
        {open ? (
          <>
            <Text variant="monoSmall">#{e.id} · hash {e.hash}…</Text>
            {Object.keys(e.data).length ? <Text variant="monoSmall">{JSON.stringify(e.data, null, 1).slice(0, 800)}</Text> : null}
          </>
        ) : null}
      </Card>
    </Pressable>
  );
}

const colorOf = (c: AuditCategory) => (c === 'auth' ? colors.cyan : c === 'scans' ? colors.green : c === 'crypto' ? colors.amber : colors.violet);

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 7, paddingHorizontal: 13, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised },
  chipOn: { borderColor: colors.violet, backgroundColor: colors.violetSoft },
});
