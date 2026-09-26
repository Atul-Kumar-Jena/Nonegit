import { useState } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { REJECTION_CODES, isRejectionCode, type FlagEntry } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Loading, Notice, Segmented, Text } from '@kit/components/ui';
import { timeAgo } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { Empty, Header, confirmAction } from '@/components/forms';
import { useFlags } from '@/queries';

type Filter = 'open' | 'valid' | 'blocked' | 'dismissed';

/** Scans the server refused as suspicious (fake GPS, wrong phone…). Review each one. */
export default function Flags() {
  const api = useApi();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('open');
  const q = useFlags(filter);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(f: FlagEntry, action: 'valid' | 'blocked' | 'dismissed') {
    setBusy(`${f.id}${action}`);
    setError(null);
    try {
      await staffApi.reviewFlag(api, f.id, action);
      void qc.invalidateQueries({ queryKey: ['staff'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header info="flags" title="Suspicious scans" />
      <Segmented
        value={filter}
        options={[
          { value: 'open', label: 'To review' },
          { value: 'valid', label: 'Accepted' },
          { value: 'blocked', label: 'Blocked' },
          { value: 'dismissed', label: 'Dismissed' },
        ]}
        onChange={setFilter}
      />
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
          <Empty title={filter === 'open' ? 'Nothing to review' : 'Nothing here'} message={filter === 'open' ? 'Refused scans that look like cheating show up here.' : undefined} />
        ) : (
          (q.data ?? []).map((f) => {
            const info = isRejectionCode(f.code) ? REJECTION_CODES[f.code] : null;
            return (
              <Card key={f.id} tone={f.status === 'open' ? 'amber' : undefined} style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text variant="bodyStrong" style={{ flex: 1 }}>
                    {f.fullName ?? 'Unknown student'}
                  </Text>
                  <Badge label={f.code} tone="amber" dot={false} />
                </View>
                <Text variant="monoSmall">{[f.rollNo, f.courseCode, timeAgo(f.at)].filter(Boolean).join(' · ')}</Text>
                <Text variant="small" color={colors.text}>
                  {info ? `${info.title}. ${info.hint}` : f.code}
                </Text>
                {f.status === 'open' ? (
                  <>
                    <Text variant="small">“Accept” marks them present for that class. “Block” keeps them absent and records it.</Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Button title="Dismiss" kind="ghost" compact loading={busy === `${f.id}dismissed`} onPress={() => void act(f, 'dismissed')} style={{ flex: 1 }} />
                      <Button title="Block" kind="danger" compact loading={busy === `${f.id}blocked`} onPress={() => void act(f, 'blocked')} style={{ flex: 1 }} />
                      <Button
                        title="Accept"
                        compact
                        loading={busy === `${f.id}valid`}
                        onPress={() => confirmAction('Mark present?', `${f.fullName ?? 'This student'} will be marked present for this class, recorded as approved by you.`, 'Mark present', () => void act(f, 'valid'))}
                        style={{ flex: 1 }}
                      />
                    </View>
                  </>
                ) : null}
              </Card>
            );
          })
        )}
      </View>
    </Screen>
  );
}
