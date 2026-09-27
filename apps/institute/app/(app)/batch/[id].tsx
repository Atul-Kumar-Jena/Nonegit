import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { BookPlus, ChevronRight, FileBarChart, FileUp, GraduationCap, Search, UserMinus, UserPlus, X } from 'lucide-react-native';
import type { BatchDetail as BatchDetailT, BatchUpdateBody } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Input, Loading, Notice, SectionLabel, Segmented, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors, radius } from '@kit/theme';
import { staffApi } from '@/api';
import { SEMESTERS, batchLine } from '@/batches';
import { Checkbox, Chips, Field, Header, Select, Sheet, ToggleRow, confirmAction } from '@/components/forms';
import { qk, useAllCourses, useBatch, useIsAdmin, usePeople, useStudentSearch } from '@/queries';

type Tab = 'students' | 'subjects' | 'settings';

/** One batch: its students, the subjects they take, and its semester. */
export default function BatchDetail() {
  const { id: raw, fresh } = useLocalSearchParams<{ id: string; fresh?: string }>();
  const id = String(raw ?? '');
  const api = useApi();
  const qc = useQueryClient();
  const q = useBatch(id);
  const admin = useIsAdmin();
  const [tab, setTab] = useState<Tab>('students');
  const [sheet, setSheet] = useState<'students' | 'subjects' | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(fresh ? 'Batch created. Next: add its students, then its subjects.' : null);

  async function update(body: Partial<BatchUpdateBody>, done: string) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const d = await staffApi.updateBatch(api, id, body);
      qc.setQueryData(qk.batch(id), d);
      void qc.invalidateQueries({ queryKey: ['staff'] });
      setInfo(done);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.members ?? []).filter((m) => (s ? `${m.fullName} ${m.rollNo ?? ''}`.toLowerCase().includes(s) : true));
  }, [q.data, search]);

  if (q.isPending) return <Screen scroll={false}><Header title="Batch" /><Loading /></Screen>;
  if (!q.data)
    return (
      <Screen>
        <Header title="Batch" />
        <ErrorState message={q.error?.message ?? 'Not found.'} onRetry={() => void q.refetch()} />
      </Screen>
    );
  const b = q.data;

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching} keyboard>
      <Header title={b.name} subtitle={batchLine(b) || 'Batch'} info="batch" />
      <View style={styles.stats}>
        <Stat n={b.size} label={b.size === 1 ? 'student' : 'students'} />
        <Stat n={b.courses.length} label={b.courses.length === 1 ? 'subject' : 'subjects'} />
        <Pressable onPress={() => router.push({ pathname: '/reports', params: { batchId: id } })} accessibilityRole="button" style={[styles.stat, { flex: 1.4 }]}>
          <FileBarChart color={colors.text} size={18} />
          <Text variant="small" color={colors.text}>
            Attendance
          </Text>
        </Pressable>
      </View>
      {!b.active ? <Notice tone="amber" message="This batch is archived." /> : null}
      {info ? <Notice tone="green" message={info} onDismiss={() => setInfo(null)} /> : null}
      {error ? <Notice tone="red" message={error} onDismiss={() => setError(null)} /> : null}

      <View style={{ marginTop: 12 }}>
        <Segmented
          value={tab}
          options={[
            { value: 'students', label: `Students · ${b.size}` },
            { value: 'subjects', label: `Subjects · ${b.courses.length}` },
            { value: 'settings', label: 'Settings' },
          ]}
          onChange={(t) => {
            setTab(t);
            setSearch('');
          }}
        />
      </View>

      {tab === 'students' ? (
        <>
          <View style={styles.actions}>
            <Button title="Add students" compact onPress={() => setSheet('students')} disabled={!b.active} icon={<UserPlus color={colors.bg} size={15} />} style={{ flex: 1 }} />
            <Button title="Paste a list" kind="secondary" compact onPress={() => router.push({ pathname: '/import', params: { batchId: id } })} disabled={!b.active} icon={<FileUp color={colors.text} size={15} />} style={{ flex: 1 }} />
          </View>
          {b.size > 8 ? <Input value={search} onChangeText={setSearch} placeholder="Search name or roll no." icon={<Search color={colors.textDim} size={16} />} autoCorrect={false} autoCapitalize="none" /> : null}
          <View style={{ gap: 6, marginTop: 10 }}>
            {shown.length === 0 ? (
              <Text variant="small" style={{ padding: 12 }}>
                {b.size ? 'No one matches.' : 'No students yet — “Add students” picks registered ones; “Paste a list” adds a whole class from a spreadsheet.'}
              </Text>
            ) : (
              shown.map((m) => (
                <View key={m.userId} style={styles.row}>
                  <Pressable
                    onPress={() => router.push({ pathname: '/student/[id]', params: { id: m.userId } })}
                    accessibilityRole="button"
                    accessibilityLabel={`${m.fullName} — attendance`}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyStrong">{m.fullName}</Text>
                      <Text variant="monoSmall">{m.rollNo ?? 'no roll no.'}</Text>
                    </View>
                    <ChevronRight color={colors.textDim} size={16} />
                  </Pressable>
                  {b.canManage ? (
                    <Pressable
                      onPress={() =>
                        confirmAction(`Remove ${m.fullName}?`, `They leave ${b.name} and its subjects (unless enrolled there directly). Past attendance is kept.`, 'Remove', () =>
                          void update({ removeMembers: [m.userId] }, `${m.fullName} removed.`), true)
                      }
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${m.fullName}`}
                      hitSlop={10}
                      style={{ paddingLeft: 6 }}
                    >
                      <UserMinus color={colors.textDim} size={18} />
                    </Pressable>
                  ) : null}
                </View>
              ))
            )}
          </View>
        </>
      ) : null}

      {tab === 'subjects' ? (
        <>
          <View style={styles.actions}>
            <Button title="Add a subject" compact onPress={() => setSheet('subjects')} disabled={!b.active} icon={<BookPlus color={colors.bg} size={15} />} style={{ flex: 1 }} />
          </View>
          <Text variant="small" style={{ marginBottom: 8 }}>
            Every student of {b.name} is enrolled in these — including students added later.
          </Text>
          <View style={{ gap: 8 }}>
            {b.courses.length === 0 ? (
              <Text variant="small" style={{ padding: 12 }}>
                No subjects yet.
              </Text>
            ) : (
              b.courses.map((c) => (
                <View key={c.id} style={styles.row}>
                  <Pressable
                    onPress={() =>
                      c.canOpen
                        ? router.push({ pathname: '/course/[id]', params: { id: c.id } })
                        : router.push({ pathname: '/reports', params: { batchId: id, courseId: c.id } })
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`${c.code} ${c.title}`}
                    style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}
                  >
                    <GraduationCap color={colors.text} size={18} />
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyStrong" numberOfLines={1}>
                        {c.code}
                        {c.title !== c.code ? ` · ${c.title}` : ''}
                      </Text>
                      <Text variant="small">{[c.instructor?.name ?? 'No teacher yet', c.kind === 'lab' ? 'Lab' : null].filter(Boolean).join(' · ')}</Text>
                    </View>
                    <ChevronRight color={colors.textDim} size={16} />
                  </Pressable>
                  {b.canManage ? (
                    <Pressable
                      onPress={() =>
                        confirmAction(`Remove ${c.code} from ${b.name}?`, 'Students who take it only through this batch are un-enrolled. Past attendance is kept.', 'Remove', () =>
                          void update({ courseIds: b.courseIds.filter((x) => x !== c.id) }, `${c.code} removed from ${b.name}.`), true)
                      }
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${c.code}`}
                      hitSlop={10}
                      style={{ paddingLeft: 6 }}
                    >
                      <X color={colors.textDim} size={18} />
                    </Pressable>
                  ) : null}
                </View>
              ))
            )}
          </View>
        </>
      ) : null}

      {tab === 'settings' ? <Settings b={b} busy={busy} update={update} /> : null}

      {sheet === 'students' ? <AddStudents b={b} onClose={() => setSheet(null)} onAdd={(ids) => update({ addMembers: ids }, `${ids.length} added — enrolled in ${b.name}’s subjects.`)} /> : null}
      {sheet === 'subjects' ? (
        <AddSubject
          b={b}
          onClose={() => setSheet(null)}
          onAttach={(ids) => update({ courseIds: [...b.courseIds, ...ids] }, `${ids.length} subject${ids.length === 1 ? '' : 's'} added — every student is enrolled.`)}
          onCreated={(d, code) => {
            qc.setQueryData(qk.batch(id), d);
            void qc.invalidateQueries({ queryKey: ['staff'] });
            setInfo(
              `${code} created in ${b.name} — every student is enrolled. ${admin ? 'Give it weekly slots in Timetable.' : 'Ask an admin to add its weekly slots, or hold a class now with “Extra class”.'}`,
            );
          }}
        />
      ) : null}
    </Screen>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <View style={styles.stat}>
      <Text variant="heading">{n}</Text>
      <Text variant="small">{label}</Text>
    </View>
  );
}

function Settings({ b, busy, update }: { b: BatchDetailT; busy: boolean; update: (body: Partial<BatchUpdateBody>, done: string) => Promise<boolean> }) {
  const [name, setName] = useState(b.name);
  const [dept, setDept] = useState(b.department ?? '');
  useEffect(() => {
    setName(b.name);
    setDept(b.department ?? '');
  }, [b.name, b.department]);
  if (!b.canManage)
    return (
      <Card style={{ marginTop: 14, gap: 6 }}>
        <Text variant="bodyStrong">{batchLine(b) || 'No semester set'}</Text>
        <Text variant="small">You can add students and subjects. Renaming, changing the semester, removing or archiving is for an admin or the teacher who created this batch.</Text>
      </Card>
    );
  const next = b.semester ? b.semester + 1 : null;
  return (
    <View style={{ marginTop: 6 }}>
      <SectionLabel>Semester</SectionLabel>
      <Chips
        value={b.semester ?? 0}
        options={[{ value: 0, label: '—' }, ...SEMESTERS.map((s) => ({ value: s, label: String(s) }))]}
        onChange={(v) =>
          v !== (b.semester ?? 0) &&
          confirmAction(v ? `Set to Semester ${v}?` : 'Clear the semester?', v ? `All ${b.size} students of ${b.name} are moved to Semester ${v}.` : 'Students keep their current semester.', 'Change', () =>
            void update({ semester: v || null }, v ? `${b.name} is now Semester ${v}.` : 'Semester cleared.'))
        }
      />
      {next && next <= 20 ? (
        <Button
          title={`Move up to Semester ${next}`}
          kind="secondary"
          onPress={() => confirmAction(`Move ${b.name} to Semester ${next}?`, `Do this at the start of the new term. All ${b.size} students move up; attendance history is kept.`, 'Move up', () => void update({ semester: next }, `${b.name} moved up to Semester ${next}.`))}
          loading={busy}
          style={{ marginTop: 12 }}
        />
      ) : null}
      <SectionLabel>Name & department</SectionLabel>
      <Field label="Batch name">
        <Input value={name} onChangeText={setName} maxLength={60} />
      </Field>
      <Field label="Department">
        <Input value={dept} onChangeText={setDept} maxLength={60} placeholder="e.g. CSE" />
      </Field>
      <Button
        title="Save"
        kind="secondary"
        onPress={() => void update({ ...(name.trim() !== b.name ? { name: name.trim() } : {}), ...(dept.trim() !== (b.department ?? '') ? { department: dept.trim() || null } : {}) }, 'Saved.')}
        disabled={!name.trim() || (name.trim() === b.name && dept.trim() === (b.department ?? ''))}
        loading={busy}
        style={{ marginTop: 10 }}
      />
      <View style={{ marginTop: 18 }}>
        <ToggleRow
          label="Active"
          hint="Archiving un-enrolls its students from the batch’s subjects (history is kept)."
          value={b.active}
          onChange={(v) =>
            v
              ? void update({ active: true }, 'Batch re-activated.')
              : confirmAction('Archive this batch?', 'Its students leave the batch’s subjects (unless enrolled directly). Attendance history is kept.', 'Archive', () => void update({ active: false }, 'Batch archived.'), true)
          }
        />
      </View>
    </View>
  );
}

function AddStudents({ b, onClose, onAdd }: { b: BatchDetailT; onClose: () => void; onAdd: (ids: string[]) => Promise<boolean> }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const hits = useStudentSearch(q.trim(), b.id);
  const list = hits.data ?? [];
  const toggle = (id: string) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Sheet open onClose={onClose} title={`Add students to ${b.name}`} scroll>
      <Input value={q} onChangeText={setQ} placeholder="Search name or roll no." icon={<Search color={colors.textDim} size={16} />} autoCorrect={false} autoCapitalize="none" />
      <View style={{ gap: 6, marginTop: 10 }}>
        {hits.isPending ? (
          <Loading />
        ) : list.length === 0 ? (
          <Text variant="small" style={{ padding: 8 }}>
            {q ? 'No registered student matches. Use “Paste a list” to add new students.' : 'Every registered student is already in this batch.'}
          </Text>
        ) : (
          list.slice(0, 80).map((p) => {
            const on = picked.has(p.userId);
            return (
              <Pressable key={p.userId} onPress={() => toggle(p.userId)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={styles.row}>
                <Checkbox checked={on} />
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{p.fullName}</Text>
                  <Text variant="monoSmall" numberOfLines={1}>
                    {[p.rollNo, p.semester ? `Sem ${p.semester}` : null, p.batches.join(', ') || null].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </View>
      {list.length > 1 ? (
        <Button
          title={picked.size === list.length ? 'Clear' : `Select all ${Math.min(list.length, 200)}`}
          kind="ghost"
          compact
          onPress={() => setPicked(picked.size === list.length ? new Set() : new Set(list.map((p) => p.userId)))}
          style={{ marginTop: 8 }}
        />
      ) : null}
      <Button
        title={picked.size ? `Add ${picked.size} to ${b.name}` : 'Pick students'}
        onPress={() => void onAdd([...picked]).then((ok) => ok && onClose())}
        disabled={!picked.size}
        icon={<UserPlus color={colors.bg} size={16} />}
        style={{ marginTop: 12 }}
      />
    </Sheet>
  );
}

function AddSubject({ b, onClose, onAttach, onCreated }: { b: BatchDetailT; onClose: () => void; onAttach: (ids: string[]) => Promise<boolean>; onCreated: (d: BatchDetailT, code: string) => void }) {
  const api = useApi();
  const admin = useIsAdmin();
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const all = useAllCourses();
  const staff = usePeople({ role: 'staff' }, admin);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'theory' | 'lab'>('theory');
  const [teacher, setTeacher] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = (all.data ?? []).filter((c) => c.active && !b.courseIds.includes(c.id));

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const d = await staffApi.batchSubject(api, b.id, { code: code.trim(), title: title.trim(), kind, instructorId: admin ? teacher : undefined });
      onCreated(d, code.trim().toUpperCase());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t create the subject.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={`Add a subject to ${b.name}`} scroll>
      <Segmented
        value={mode}
        options={[
          { value: 'existing', label: 'Existing subject' },
          { value: 'new', label: 'New subject' },
        ]}
        onChange={setMode}
      />
      {mode === 'existing' ? (
        <>
          <View style={{ gap: 6, marginTop: 12 }}>
            {all.isPending ? (
              <Loading />
            ) : options.length === 0 ? (
              <Text variant="small" style={{ padding: 8 }}>
                Every subject is already in this batch. Create a new one instead.
              </Text>
            ) : (
              options.map((c) => {
                const on = picked.has(c.id);
                return (
                  <Pressable
                    key={c.id}
                    onPress={() =>
                      setPicked((cur) => {
                        const n = new Set(cur);
                        if (n.has(c.id)) n.delete(c.id);
                        else n.add(c.id);
                        return n;
                      })
                    }
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    style={styles.row}
                  >
                    <Checkbox checked={on} />
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyStrong" numberOfLines={1}>
                        {c.code}
                        {c.title !== c.code ? ` · ${c.title}` : ''}
                      </Text>
                      <Text variant="small">{c.instructor?.name ?? 'No teacher yet'}</Text>
                    </View>
                  </Pressable>
                );
              })
            )}
          </View>
          <Button title={picked.size ? `Add ${picked.size}` : 'Pick subjects'} onPress={() => void onAttach([...picked]).then((ok) => ok && onClose())} disabled={!picked.size} style={{ marginTop: 14 }} />
        </>
      ) : (
        <>
          <Field label="Code" hint="Unique in the institution, e.g. CS-501.">
            <Input value={code} onChangeText={setCode} placeholder="CS-501" maxLength={20} autoCapitalize="characters" autoCorrect={false} />
          </Field>
          <Field label="Title">
            <Input value={title} onChangeText={setTitle} placeholder="Compiler Design" maxLength={120} />
          </Field>
          <Field label="Type">
            <Chips value={kind} options={[{ value: 'theory', label: 'Theory' }, { value: 'lab', label: 'Lab' }]} onChange={setKind} />
          </Field>
          {admin ? (
            <Field label="Teacher">
              <Select
                title="Teacher"
                value={teacher}
                onChange={setTeacher}
                allowNone="Assign later"
                options={(staff.data ?? []).filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: p.fullName, sub: p.department ?? undefined }))}
              />
            </Field>
          ) : (
            <View style={{ marginTop: 12 }}>
              <Badge label="You will teach this subject" tone="muted" dot={false} />
            </View>
          )}
          {error ? (
            <View style={{ marginTop: 10 }}>
              <Notice tone="red" message={error} />
            </View>
          ) : null}
          <Button title="Create subject" onPress={() => void create()} loading={busy} disabled={!code.trim() || !title.trim()} style={{ marginTop: 16 }} />
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: 'row', gap: 10, marginTop: 12, marginBottom: 4 },
  stat: { flex: 1, gap: 2, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
});
