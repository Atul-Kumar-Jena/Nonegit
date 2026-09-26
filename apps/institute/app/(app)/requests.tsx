import { useState } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Smartphone } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Loading, Notice, Text } from '@kit/components/ui';
import { timeAgo } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { Empty, Header, confirmAction } from '@/components/forms';
import { useDeviceRequests } from '@/queries';

/** Phone switches and resets waiting for approval. One person, one phone — nobody can approve their own. */
export default function Requests() {
  const api = useApi();
  const qc = useQueryClient();
  const q = useDeviceRequests();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: 'approve' | 'deny') {
    setBusy(id + decision);
    setError(null);
    try {
      await staffApi.decide(api, id, decision);
      void qc.invalidateQueries({ queryKey: ['staff'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the decision.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header info="phoneRequests" title="Phone requests" />
      <Text variant="small">
        Each account works on one phone. Approve only if you’re sure the request is genuine — e.g. the person told you they changed phones.
      </Text>
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      <View style={{ gap: 10, marginTop: 14 }}>
        {q.isPending ? (
          <Loading />
        ) : q.isError && !q.data ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : (q.data ?? []).length === 0 ? (
          <Empty title="No pending requests" />
        ) : (
          (q.data ?? []).map((r) => (
            <Card key={r.id} style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text variant="bodyStrong" style={{ flex: 1 }}>
                  {r.user.fullName}
                </Text>
                <Badge label={r.kind === 'rebind' ? 'New phone' : 'Reset'} tone={r.kind === 'rebind' ? 'violet' : 'amber'} dot={false} />
              </View>
              <Text variant="monoSmall">
                {[r.user.rollNo, r.user.role, timeAgo(r.createdAt)].filter(Boolean).join(' · ')}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Smartphone color={colors.textDim} size={14} />
                <Text variant="small" style={{ flexShrink: 1 }}>
                  {r.from ? r.from.model : 'no phone'}
                </Text>
                <ArrowRight color={colors.textDim} size={14} />
                <Text variant="small" color={colors.text} style={{ flexShrink: 1 }}>
                  {r.to ? `${r.to.model} (${r.to.platform})` : 'unbound — binds at next sign-in'}
                </Text>
              </View>
              <Text variant="body" color={colors.text}>
                “{r.reason}”
              </Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Button title="Deny" kind="secondary" compact loading={busy === r.id + 'deny'} onPress={() => void decide(r.id, 'deny')} style={{ flex: 1 }} />
                <Button
                  title="Approve"
                  compact
                  loading={busy === r.id + 'approve'}
                  onPress={() =>
                    confirmAction('Approve?', `${r.user.fullName}’s old phone stops working immediately${r.kind === 'rebind' ? ' and the new one is bound' : ''}.`, 'Approve', () => void decide(r.id, 'approve'))
                  }
                  style={{ flex: 1 }}
                />
              </View>
            </Card>
          ))
        )}
      </View>
    </Screen>
  );
}
