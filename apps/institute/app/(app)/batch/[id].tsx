import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp, Search, UserMinus, UserPlus } from 'lucide-react-native';
import type { BatchUpdateBody } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Button, Card, ErrorState, Input, Loading, Notice, SectionLabel, Segmented, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors, radius } from '@kit/theme';
import { staffApi } from '@/api';
import { Checkbox, Field, Header, ToggleRow, confirmAction } from '@/components/forms';
import { useBatch, useCourses, useIsAdmin, usePeople } from '@/queries';

/** One batch: its name, the courses it takes, and its students. */
export default function BatchDetail() {
  const { id: raw } = useLocalSearchParams<{ id: string }>();
  const id = String(raw ?? '');
  const api = useApi();
  const qc = useQueryClient();
  const admin = useIsAdmin();
  const q = useBatch(id);
  const courses = useCourses();
  const [tab, setTab] = useState<'members' | 'add' | 'courses'>('members');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [courseSel, setCourseSel] = useState<Set<string> | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const students = usePeople({ role: 'student', q: tab === 'add' ? search.trim() || undefined : undefined });

  useEffect(() => {
    if (q.data && courseSel === null) setCourseSel(new Set(q.data.courseIds));
    if (q.data && name === null) setName(q.data.name);
  }, [q.data, courseSel, name]);

  const members = useMemo(() => new Set((q.data?.members ?? []).map((m) => m.userId)), [q.data]);
  const shownMembers = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.members ?? []).filter((m) => (s ? `${m.fullName} ${m.rollNo ?? ''}`.toLowerCase().includes(s) : true));
  }, [q.data, search]);
  const candidates = useMemo(() => (students.data ?? []).filter((p) => !members.has(p.id) && p.status === 'active'), [students.data, members]);

  async function update(body: Partial<BatchUpdateBody>, done: string) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const d = await staffApi.updateBatch(api, id, body);
      qc.setQueryData(['staff', 'batch', id], d);
      void qc.invalidateQueries({ queryKey: ['staff'] });
      setInfo(done);
      setPicked(new Set());
      setCourseSel(new Set(d.courseIds));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save.');
    } finally {
      setBusy(false);
    }
  }

  if (q.isPending) return <Screen scroll={false}><Header title="Batch" /><Loading /></Screen>;
  if (!q.data)
    return (
      <Screen>
        <Header title="Batch" />
        <ErrorState message={q.error?.message ?? 'Not found.'} onRetry={() => void q.refetch()} />
      </Screen>
    );
  const b = q.data;
  const coursesChanged = courseSel !== null && (courseSel.size !== b.courseIds.length || b.courseIds.some((c) => !courseSel.has(c)));

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching} keyboard>
      <Header title={b.name} subtitle={`${b.size} students · ${b.courseIds.length} courses`} />
      {info ? <Notice tone="green" message={info} onDismiss={() => setInfo(null)} /> : null}
      {error ? <Notice tone="red" message={error} onDismiss={() => setError(null)} /> : null}
      <View style={{ marginTop: 10 }}>
        <Segmented
          value={tab}
          options={[
            { value: 'members', label: `Students · ${b.size}` },
            ...(admin ? [{ value: 'add' as const, label: 'Add' }] : []),
            { value: 'courses', label: 'Courses & name' },
          ]}
          onChange={(t) => {
            setTab(t);
            setSearch('');
            setPicked(new Set());
          }}
        />
      </View>

      {tab !== 'courses' ? (
        <View style={{ marginTop: 12 }}>
          <Input value={search} onChangeText={setSearch} placeholder="Search name or roll no." icon={<Search color={colors.textDim} size={16} />} autoCorrect={false} autoCapitalize="none" />
        </View>
      ) : null}

      {tab === 'members' ? (
        <View style={{ gap: 6, marginTop: 10 }}>
          {shownMembers.length === 0 ? (
            <Text variant="small" style={{ padding: 12 }}>
              {b.size ? 'No one matches.' : 'No students yet — use “Add”, or paste a list with this batch selected.'}
            </Text>
          ) : (
            shownMembers.map((m) => (
              <View key={m.userId} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{m.fullName}</Text>
                  <Text variant="monoSmall">{m.rollNo ?? 'no roll no.'}</Text>
                </View>
                {admin ? (
                  <Pressable
                    onPress={() =>
                      confirmAction(`Remove ${m.fullName}?`, `They leave ${b.name} and its courses (unless enrolled there directly). Past attendance is kept.`, 'Remove', () =>
                        void update({ removeMembers: [m.userId] }, `${m.fullName} removed.`), true)
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${m.fullName}`}
                    hitSlop={8}
                  >
                    <UserMinus color={colors.textDim} size={18} />
                  </Pressable>
                ) : null}
              </View>
            ))
          )}
          {admin ? (
            <Button title="Paste a list into this batch" kind="secondary" onPress={() => router.push({ pathname: '/import', params: { batchId: id } })} icon={<FileUp color={colors.text} size={16} />} style={{ marginTop: 8 }} />
          ) : null}
        </View>
      ) : null}

      {tab === 'add' ? (
        <View style={{ gap: 6, marginTop: 10 }}>
          {students.isPending ? (
            <Loading />
          ) : candidates.length === 0 ? (
            <Text variant="small" style={{ padding: 12 }}>
              {search ? 'No student matches (or they’re already in this batch).' : 'Every student is already in this batch, or none have been added yet.'}
            </Text>
          ) : (
            candidates.map((p) => {
              const on = picked.has(p.id);
              return (
                <Pressable
                  key={p.id}
                  onPress={() =>
                    setPicked((cur) => {
                      const n = new Set(cur);
                      if (n.has(p.id)) n.delete(p.id);
                      else n.add(p.id);
                      return n;
                    })
                  }
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={styles.row}
                >
                  <Checkbox checked={on} />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong">{p.fullName}</Text>
                    <Text variant="monoSmall">{[p.rollNo, p.department, p.semester ? `Sem ${p.semester}` : null].filter(Boolean).join(' · ') || p.email}</Text>
                  </View>
                </Pressable>
              );
            })
          )}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <Button title={picked.size === candidates.length && candidates.length ? 'Clear' : `Select all ${candidates.length}`} kind="secondary" compact disabled={!candidates.length} onPress={() => setPicked(picked.size === candidates.length ? new Set() : new Set(candidates.map((c) => c.id)))} />
            <Button title={`Add ${picked.size || ''}`.trim()} onPress={() => void update({ addMembers: [...picked] }, `${picked.size} added — enrolled in the batch’s courses.`)} loading={busy} disabled={!picked.size} icon={<UserPlus color="#0a0a0a" size={16} />} style={{ flex: 1 }} />
          </View>
        </View>
      ) : null}

      {tab === 'courses' ? (
        <>
          <SectionLabel>Courses this batch takes</SectionLabel>
          <Card style={{ gap: 2 }}>
            {(courses.data ?? []).filter((c) => c.active).map((c) => {
              const on = courseSel?.has(c.id) ?? false;
              return (
                <Pressable
                  key={c.id}
                  disabled={!admin}
                  onPress={() =>
                    setCourseSel((cur) => {
                      const n = new Set(cur ?? []);
                      if (n.has(c.id)) n.delete(c.id);
                      else n.add(c.id);
                      return n;
                    })
                  }
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={styles.course}
                >
                  <Checkbox checked={on} size={20} />
                  <View style={{ flex: 1 }}>
                    <Text variant="body" color={on ? colors.text : undefined}>
                      {c.code} · {c.title}
                    </Text>
                    <Text variant="small">{c.instructor?.name ?? 'No teacher'}</Text>
                  </View>
                </Pressable>
              );
            })}
          </Card>
          {admin ? (
            <Button
              title="Save courses"
              onPress={() => void update({ courseIds: [...(courseSel ?? [])] }, 'Saved. Students were enrolled / un-enrolled to match.')}
              loading={busy}
              disabled={!coursesChanged}
              style={{ marginTop: 12 }}
            />
          ) : null}
          {admin ? (
            <>
              <SectionLabel>Name</SectionLabel>
              <Field label="Batch name">
                <Input value={name ?? ''} onChangeText={setName} maxLength={60} />
              </Field>
              <Button title="Rename" kind="secondary" onPress={() => void update({ name: (name ?? '').trim() }, 'Renamed.')} disabled={!name?.trim() || name.trim() === b.name} style={{ marginTop: 10 }} />
              <View style={{ marginTop: 14 }}>
                <ToggleRow
                  label="Active"
                  hint="Archiving a batch un-enrolls its students from the batch’s courses (history is kept)."
                  value={b.active}
                  onChange={(v) =>
                    v
                      ? void update({ active: true }, 'Batch re-activated.')
                      : confirmAction('Archive this batch?', 'Its students leave the batch’s courses (unless enrolled directly). Attendance history is kept.', 'Archive', () => void update({ active: false }, 'Batch archived.'), true)
                  }
                />
              </View>
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  course: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
});
