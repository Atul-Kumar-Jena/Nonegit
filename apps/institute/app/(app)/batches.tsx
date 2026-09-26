import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus, UsersRound } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Input, Loading, Notice, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { Empty, Field, Header, Sheet } from '@/components/forms';
import { useBatches, useCourses, useIsAdmin } from '@/queries';

/** Batches: sections / classes / years. Attach a batch to courses and its students are enrolled automatically. */
export default function Batches() {
  const admin = useIsAdmin();
  const q = useBatches();
  const courses = useCourses();
  const [open, setOpen] = useState(false);
  const code = (id: string) => courses.data?.find((c) => c.id === id)?.code ?? '…';

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header title="Batches" right={admin ? <Button title="New" compact onPress={() => setOpen(true)} icon={<Plus color="#03141c" size={15} />} /> : undefined} />
      <Text variant="small">
        A batch is a group of students who study together (e.g. “CSE 2024 · Sec A”). Attach it to courses and every member is enrolled — new members too. Timetable changes reach exactly the batches affected.
      </Text>
      <View style={{ gap: 10, marginTop: 14 }}>
        {q.isPending ? (
          <Loading />
        ) : q.isError && !q.data ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : (q.data ?? []).length === 0 ? (
          <Empty title="No batches yet" message="Create one per section, then add its students." action={admin ? <Button title="Create a batch" onPress={() => setOpen(true)} /> : undefined} />
        ) : (
          (q.data ?? []).map((b) => (
            <Pressable key={b.id} onPress={() => router.push({ pathname: '/batch/[id]', params: { id: b.id } })} accessibilityRole="button">
              <Card style={[styles.row, !b.active && { opacity: 0.55 }]}>
                <UsersRound color={colors.cyan} size={20} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="bodyStrong">{b.name}</Text>
                  <Text variant="small" numberOfLines={1}>
                    {b.size} {b.size === 1 ? 'student' : 'students'} · {b.courseIds.length ? b.courseIds.map(code).join(', ') : 'no courses yet'}
                  </Text>
                </View>
                {!b.active ? <Badge label="Archived" tone="muted" dot={false} /> : null}
                <ChevronRight color={colors.textDim} size={16} />
              </Card>
            </Pressable>
          ))
        )}
      </View>
      {open ? <NewBatch onClose={() => setOpen(false)} /> : null}
    </Screen>
  );
}

function NewBatch({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const b = await staffApi.createBatch(api, name.trim());
      void qc.invalidateQueries({ queryKey: ['staff'] });
      onClose();
      router.push({ pathname: '/batch/[id]', params: { id: b.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t create the batch.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open onClose={onClose} title="New batch">
      <Field label="Name" hint="Unique, e.g. “CSE 2024 · Sec A” or “BBA Year 1”.">
        <Input value={name} onChangeText={setName} placeholder="CSE 2024 · Sec A" maxLength={60} autoFocus />
      </Field>
      {error ? (
        <View style={{ marginTop: 10 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      <Button title="Create batch" onPress={() => void create()} loading={busy} disabled={!name.trim()} style={{ marginTop: 16 }} />
    </Sheet>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 12 } });
