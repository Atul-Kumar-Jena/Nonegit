import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Search, UserMinus, UserPlus } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Button, Input, Loading, Notice, Segmented, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors, radius } from '@kit/theme';
import { staffApi } from '@/api';
import { Checkbox, Header, confirmAction } from '@/components/forms';
import { useCourses, usePeople, useRoster } from '@/queries';

/** Who is in a course (admins). Only enrolled students can scan or be ticked. */
export default function Roster() {
  const { courseId: raw } = useLocalSearchParams<{ courseId: string }>();
  const courseId = String(raw ?? '');
  const api = useApi();
  const qc = useQueryClient();
  const course = useCourses().data?.find((c) => c.id === courseId);
  const roster = useRoster(courseId);
  const [tab, setTab] = useState<'in' | 'add'>('in');
  const [q, setQ] = useState('');
  const everyone = usePeople({ role: 'student', q: tab === 'add' ? q.trim() || undefined : undefined });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enrolled = useMemo(() => new Set((roster.data ?? []).map((r) => r.userId)), [roster.data]);
  const inList = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (roster.data ?? []).filter((r) => (s ? `${r.fullName} ${r.rollNo ?? ''}`.toLowerCase().includes(s) : true));
  }, [roster.data, q]);
  const candidates = useMemo(() => (everyone.data ?? []).filter((p) => !enrolled.has(p.id) && p.status === 'active'), [everyone.data, enrolled]);

  async function apply(add: string[], remove: string[]) {
    setBusy(true);
    setError(null);
    try {
      const next = await staffApi.enroll(api, courseId, { add, remove });
      qc.setQueryData(['staff', 'roster', courseId], next);
      void qc.invalidateQueries({ queryKey: ['staff'] });
      setPicked(new Set());
      if (add.length) setTab('in');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t update the course.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen scroll={false} keyboard>
      <Header title="Students" subtitle={course ? `${course.code} · ${course.title}` : undefined} />
      <Segmented
        value={tab}
        options={[
          { value: 'in', label: `Enrolled · ${roster.data?.length ?? '…'}` },
          { value: 'add', label: 'Add students' },
        ]}
        onChange={(t) => {
          setTab(t);
          setQ('');
          setPicked(new Set());
        }}
      />
      <View style={{ marginTop: 12 }}>
        <Input value={q} onChangeText={setQ} placeholder="Search name, roll no. or email" icon={<Search color={colors.textDim} size={16} />} autoCorrect={false} autoCapitalize="none" />
      </View>
      {error ? (
        <View style={{ marginTop: 10 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}

      {tab === 'in' ? (
        roster.isPending ? (
          <Loading />
        ) : (
          <FlatList
            style={{ flex: 1, marginTop: 10 }}
            data={inList}
            keyExtractor={(r) => r.userId}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{item.fullName}</Text>
                  <Text variant="monoSmall">{item.rollNo ?? 'no roll no.'}</Text>
                </View>
                <Pressable
                  onPress={() =>
                    confirmAction(`Remove ${item.fullName}?`, 'They leave this course. Their past attendance is kept but no longer counts here.', 'Remove', () => void apply([], [item.userId]), true)
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${item.fullName}`}
                  hitSlop={8}
                >
                  <UserMinus color={colors.textDim} size={18} />
                </Pressable>
              </View>
            )}
            ListEmptyComponent={
              <Text variant="small" style={{ padding: 16 }}>
                {roster.data?.length ? 'No one matches.' : 'No students yet — open “Add students”.'}
              </Text>
            }
          />
        )
      ) : (
        <>
          <FlatList
            style={{ flex: 1, marginTop: 10 }}
            data={candidates}
            keyExtractor={(p) => p.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const on = picked.has(item.id);
              return (
                <Pressable
                  onPress={() =>
                    setPicked((cur) => {
                      const n = new Set(cur);
                      if (n.has(item.id)) n.delete(item.id);
                      else n.add(item.id);
                      return n;
                    })
                  }
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={styles.row}
                >
                  <Checkbox checked={on} />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong">{item.fullName}</Text>
                    <Text variant="monoSmall">{[item.rollNo, item.department, item.semester ? `Sem ${item.semester}` : null].filter(Boolean).join(' · ') || item.email}</Text>
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              everyone.isPending ? (
                <Loading />
              ) : (
                <View style={{ padding: 16, gap: 10 }}>
                  <Text variant="small">{q ? 'No student matches (or they’re already enrolled).' : 'Every student is already in this course, or none have been added yet.'}</Text>
                  <Button title="Add new students" kind="secondary" onPress={() => router.push('/import')} />
                </View>
              )
            }
          />
          <View style={styles.footer}>
            <Button
              title={candidates.length && picked.size === candidates.length ? 'Clear' : `Select all ${candidates.length}`}
              kind="secondary"
              compact
              disabled={!candidates.length}
              onPress={() => setPicked(picked.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.id)))}
            />
            <Button title={`Enrol ${picked.size || ''}`.trim()} onPress={() => void apply([...picked], [])} loading={busy} disabled={!picked.size} icon={<UserPlus color="#03141c" size={16} />} style={{ flex: 1 }} />
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 6, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  footer: { flexDirection: 'row', gap: 10, alignItems: 'center', paddingTop: 10 },
});
