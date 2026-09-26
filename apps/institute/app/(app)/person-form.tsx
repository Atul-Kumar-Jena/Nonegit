import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { PersonBody, PersonUpdateBody } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Button, Card, Input, Loading, Notice, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { Checkbox, Chips, Field, Header, firstIssue } from '@/components/forms';
import { useCourses, usePerson } from '@/queries';

type Role = 'student' | 'teacher' | 'admin';

/** Add or edit one person (admins). Email and phone are unique across Attendly; roll numbers within the institution. */
export default function PersonForm() {
  const params = useLocalSearchParams<{ id?: string; role?: string }>();
  const id = params.id ? String(params.id) : null;
  const api = useApi();
  const qc = useQueryClient();
  const existing = usePerson(id ?? '');
  const courses = useCourses();

  const [role, setRole] = useState<Role>(params.role === 'teacher' || params.role === 'admin' ? params.role : 'student');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [rollNo, setRollNo] = useState('');
  const [department, setDepartment] = useState('');
  const [semester, setSemester] = useState('');
  const [courseIds, setCourseIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(!id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = existing.data;
    if (!id || !p || loaded) return;
    setRole(p.role === 'developer' ? 'admin' : p.role);
    setFullName(p.fullName);
    setEmail(p.email ?? '');
    setPhone(p.phone ?? '');
    setRollNo(p.rollNo ?? '');
    setDepartment(p.department ?? '');
    setSemester(p.semester ? String(p.semester) : '');
    setCourseIds(new Set(p.courseIds));
    setLoaded(true);
  }, [existing.data, id, loaded]);

  if (id && !loaded) return <Screen scroll={false}><Header title="Edit person" />{existing.isPending ? <Loading /> : <Notice tone="red" message="Person not found." />}</Screen>;

  async function save() {
    setError(null);
    const sem = semester.trim() ? Number(semester) : null;
    if (sem !== null && (!Number.isInteger(sem) || sem < 1 || sem > 20)) return setError('Semester must be a number from 1 to 20.');
    const common = {
      fullName: fullName.trim(),
      email: email.trim() ? email.trim().toLowerCase() : null,
      phone: phone.trim() ? phone.replace(/[\s-]/g, '') : null,
      rollNo: role === 'student' ? rollNo : null,
      department,
      semester: role === 'student' ? sem : null,
      ...(role === 'student' ? { courseIds: [...courseIds] } : {}),
    };
    setBusy(true);
    try {
      if (id) {
        const parsed = PersonUpdateBody.safeParse(common);
        if (!parsed.success) throw new Error(firstIssue(parsed.error));
        await staffApi.updatePerson(api, id, parsed.data);
        void qc.invalidateQueries({ queryKey: ['staff'] });
        router.back();
      } else {
        const parsed = PersonBody.safeParse({ role, ...common });
        if (!parsed.success) throw new Error(firstIssue(parsed.error));
        const p = await staffApi.createPerson(api, parsed.data);
        void qc.invalidateQueries({ queryKey: ['staff'] });
        router.replace({ pathname: '/people/[id]', params: { id: p.id } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard>
      <Header title={id ? 'Edit person' : 'Add person'} />
      {!id ? (
        <Field label="Role">
          <Chips
            value={role}
            options={[
              { value: 'student', label: 'Student' },
              { value: 'teacher', label: 'Teacher' },
              { value: 'admin', label: 'Admin' },
            ]}
            onChange={setRole}
          />
        </Field>
      ) : null}
      {role === 'admin' && !id ? (
        <View style={{ marginTop: 10 }}>
          <Notice tone="amber" message="Admins can change everything: people, timetable, settings and every register. Add only people you fully trust." />
        </View>
      ) : null}
      <Field label="Full name">
        <Input value={fullName} onChangeText={setFullName} placeholder="As on the ID card" maxLength={120} autoCapitalize="words" />
      </Field>
      <Field label="Email" hint="They sign in with a one-time code sent here.">
        <Input value={email} onChangeText={setEmail} placeholder="name@college.edu" keyboardType="email-address" autoCapitalize="none" autoCorrect={false} maxLength={254} />
      </Field>
      <Field label="Mobile (optional)" hint="With country code, e.g. +919876543210.">
        <Input value={phone} onChangeText={setPhone} placeholder="+91…" keyboardType="phone-pad" maxLength={20} />
      </Field>
      {role === 'student' ? (
        <>
          <Field label="Roll number" hint="Unique within your institution.">
            <Input value={rollNo} onChangeText={setRollNo} placeholder="21CS1043" autoCapitalize="characters" autoCorrect={false} maxLength={40} />
          </Field>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 2 }}>
              <Field label="Department">
                <Input value={department} onChangeText={setDepartment} placeholder="CSE" maxLength={60} />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Semester">
                <Input value={semester} onChangeText={(t) => setSemester(t.replace(/\D/g, '').slice(0, 2))} placeholder="5" keyboardType="number-pad" />
              </Field>
            </View>
          </View>
          <Field label="Courses">
            <Card style={{ gap: 4 }}>
              {(courses.data ?? []).filter((c) => c.active).length === 0 ? (
                <Text variant="small">No courses yet — you can enrol them later.</Text>
              ) : (
                (courses.data ?? [])
                  .filter((c) => c.active)
                  .map((c) => {
                    const on = courseIds.has(c.id);
                    return (
                      <Pressable
                        key={c.id}
                        onPress={() =>
                          setCourseIds((cur) => {
                            const n = new Set(cur);
                            if (n.has(c.id)) n.delete(c.id);
                            else n.add(c.id);
                            return n;
                          })
                        }
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on }}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 }}
                      >
                        <Checkbox checked={on} size={20} />
                        <Text variant="body" color={on ? colors.text : undefined} style={{ flex: 1 }}>
                          {c.code} · {c.title}
                        </Text>
                      </Pressable>
                    );
                  })
              )}
            </Card>
          </Field>
        </>
      ) : (
        <Field label="Department (optional)">
          <Input value={department} onChangeText={setDepartment} placeholder="CSE" maxLength={60} />
        </Field>
      )}
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      <Button title={id ? 'Save changes' : `Add ${role}`} onPress={() => void save()} loading={busy} disabled={!fullName.trim()} style={{ marginTop: 20 }} />
    </Screen>
  );
}
