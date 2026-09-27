import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, UsersRound } from 'lucide-react-native';
import type { Batch } from '@attendly/protocol';
import { Badge, Button, Card, ErrorState, Input, Loading, Notice, SectionLabel, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { staffApi } from '@/api';
import { SEMESTERS } from '@/batches';
import { colors } from '@kit/theme';
import { Chips, Empty, Field, Sheet } from '@/components/forms';
import { useBatches } from '@/queries';

/** Every batch, grouped by semester (the top of the hierarchy). */
export function BatchList({ onCreate }: { onCreate: () => void }) {
  const q = useBatches();
  const [showArchived, setShowArchived] = useState(false);
  const groups = useMemo(() => {
    const by = new Map<string, Batch[]>();
    for (const b of (q.data ?? []).filter((x) => showArchived || x.active)) {
      const k = b.semester ? `Semester ${b.semester}` : 'No semester set';
      by.set(k, [...(by.get(k) ?? []), b]);
    }
    return [...by.entries()];
  }, [q.data, showArchived]);
  const archived = (q.data ?? []).filter((b) => !b.active).length;

  if (q.isPending) return <Loading />;
  if (q.isError && !q.data) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  if (!groups.length && !archived)
    return (
      <View style={{ marginTop: 14 }}>
        <Empty title="No batches yet" message="Create one per section (e.g. CSE-5A), then add its students and subjects." action={<Button title="Create a batch" onPress={onCreate} />} />
      </View>
    );
  return (
    <View>
      {groups.map(([label, list]) => (
        <View key={label}>
          <SectionLabel>{label}</SectionLabel>
          <View style={{ gap: 10 }}>
            {list.map((b) => (
              <Pressable key={b.id} onPress={() => router.push({ pathname: '/batch/[id]', params: { id: b.id } })} accessibilityRole="button" accessibilityLabel={`${b.name}, ${b.size} students`}>
                <Card style={[styles.row, !b.active && { opacity: 0.55 }]}>
                  <UsersRound color={colors.text} size={20} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="bodyStrong">{b.name}</Text>
                    <Text variant="small" numberOfLines={1}>
                      {[b.department, `${b.size} ${b.size === 1 ? 'student' : 'students'}`, `${b.courseIds.length} ${b.courseIds.length === 1 ? 'subject' : 'subjects'}`].filter(Boolean).join(' · ')}
                    </Text>
                    <Text variant="small" numberOfLines={1} color={b.mentor ? colors.text : colors.textDim}>
                      {b.mentor ? `Mentor: ${b.mentor.name}` : 'No mentor yet'}
                    </Text>
                  </View>
                  {!b.active ? <Badge label="Archived" tone="muted" dot={false} /> : null}
                  <ChevronRight color={colors.textDim} size={16} />
                </Card>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
      {archived ? <Button title={showArchived ? 'Hide archived' : `Show ${archived} archived`} kind="ghost" compact onPress={() => setShowArchived(!showArchived)} style={{ marginTop: 12 }} /> : null}
    </View>
  );
}

export function NewBatch({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const [semester, setSemester] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const b = await staffApi.createBatch(api, { name: name.trim(), active: true, department: department.trim() || null, semester });
      void qc.invalidateQueries({ queryKey: ['staff'] });
      onClose();
      router.push({ pathname: '/batch/[id]', params: { id: b.id, fresh: '1' } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t create the batch.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet open onClose={onClose} title="New batch">
      <Field label="Name" hint="Unique, e.g. “CSE-5A” or “BBA Year 1 · Sec B”.">
        <Input value={name} onChangeText={setName} placeholder="CSE-5A" maxLength={60} autoFocus />
      </Field>
      <Field label="Department (optional)">
        <Input value={department} onChangeText={setDepartment} placeholder="CSE" maxLength={60} />
      </Field>
      <Field label="Semester" hint="Its students get this semester. Move the batch up at the end of term.">
        <Chips value={semester ?? 0} options={[{ value: 0, label: '—' }, ...SEMESTERS.map((s) => ({ value: s, label: String(s) }))]} onChange={(v) => setSemester(v || null)} />
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
