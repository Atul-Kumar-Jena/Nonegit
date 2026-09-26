import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { CourseBody, type SessionMode } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Button, Card, Input, Loading, Notice, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { staffApi } from '@/api';
import { Chips, Field, Header, Select, ToggleRow, firstIssue } from '@/components/forms';
import { useCourses, usePeople } from '@/queries';

/** Create or edit a course (admins). Course codes are unique within the institution. */
export default function CourseForm() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ? String(params.id) : null;
  const api = useApi();
  const qc = useQueryClient();
  const courses = useCourses();
  const staff = usePeople({ role: 'staff' });
  const existing = id ? courses.data?.find((c) => c.id === id) : undefined;

  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'theory' | 'lab'>('theory');
  const [mode, setMode] = useState<SessionMode>('qr');
  const [instructorId, setInstructor] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [loaded, setLoaded] = useState(!id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!existing || loaded) return;
    setCode(existing.code);
    setTitle(existing.title);
    setKind(existing.kind);
    setMode(existing.defaultMode);
    setInstructor(existing.instructor?.id ?? null);
    setActive(existing.active);
    setLoaded(true);
  }, [existing, loaded]);

  if (id && !loaded) return <Screen scroll={false}><Header title="Course" />{courses.isPending ? <Loading /> : <Notice tone="red" message="Course not found." />}</Screen>;

  async function save() {
    setError(null);
    const parsed = CourseBody.safeParse({ code, title, kind, defaultMode: mode, instructorId, active });
    if (!parsed.success) return setError(firstIssue(parsed.error));
    setBusy(true);
    try {
      const c = await staffApi.saveCourse(api, id, parsed.data);
      void qc.invalidateQueries({ queryKey: ['staff'] });
      if (id) router.back();
      else router.replace({ pathname: '/course/[id]', params: { id: c.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard>
      <Header title={id ? 'Edit course' : 'New course'} />
      <Field label="Course code" hint="Unique in your institution, e.g. CS-301.">
        <Input value={code} onChangeText={(t) => setCode(t.toUpperCase())} placeholder="CS-301" autoCapitalize="characters" autoCorrect={false} maxLength={20} />
      </Field>
      <Field label="Title">
        <Input value={title} onChangeText={setTitle} placeholder="Operating Systems" maxLength={120} />
      </Field>
      <Field label="Type">
        <Chips value={kind} options={[{ value: 'theory', label: 'Theory' }, { value: 'lab', label: 'Lab' }]} onChange={setKind} />
      </Field>
      <Field label="Usual attendance method" hint="Each class can still switch when it starts.">
        <Chips value={mode} options={[{ value: 'qr', label: 'QR scan' }, { value: 'manual', label: 'Paper-style register' }]} onChange={setMode} />
      </Field>
      <Field label="Teacher" hint={staff.data?.length === 0 ? 'Add teachers under More → People.' : 'Only this teacher (and admins) can run its classes.'}>
        <Select
          title="Teacher"
          value={instructorId}
          onChange={setInstructor}
          allowNone="No teacher yet"
          options={(staff.data ?? []).filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: p.fullName, sub: `${p.role === 'admin' ? 'Admin' : 'Teacher'}${p.email ? ` · ${p.email}` : ''}` }))}
        />
      </Field>
      {id ? (
        <Card style={{ marginTop: 16 }}>
          <ToggleRow label="Active" hint="Archived courses keep their history but no new classes." value={active} onChange={setActive} />
        </Card>
      ) : null}
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      <Button title={id ? 'Save changes' : 'Create course'} onPress={() => void save()} loading={busy} style={{ marginTop: 20 }} />
      {!id ? (
        <Text variant="small" style={{ marginTop: 10 }}>
          Next you’ll add students and weekly timetable slots.
        </Text>
      ) : null}
    </Screen>
  );
}
