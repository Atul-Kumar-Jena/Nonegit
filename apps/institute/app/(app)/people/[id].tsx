import { useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, Pencil, Smartphone } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Avatar, Badge, Button, Card, ErrorState, InfoRow, Loading, Notice, SectionLabel, Text } from '@kit/components/ui';
import { dateLong, initials } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { Header, confirmAction } from '@/components/forms';
import { useCourses, useMe, usePerson } from '@/queries';

/** One person (admins): details, their courses, their phone, suspend / reset. */
export default function PersonDetail() {
  const { id: raw } = useLocalSearchParams<{ id: string }>();
  const id = String(raw ?? '');
  const api = useApi();
  const qc = useQueryClient();
  const me = useMe();
  const q = usePerson(id);
  const courses = useCourses();
  const [busy, setBusy] = useState<null | 'status' | 'device'>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  if (q.isPending) return <Screen scroll={false}><Header title="Person" /><Loading /></Screen>;
  if (!q.data)
    return (
      <Screen>
        <Header title="Person" />
        <ErrorState message={q.error?.message ?? 'Not found.'} onRetry={() => void q.refetch()} />
      </Screen>
    );

  const p = q.data;
  const self = me.data?.user.id === p.id;
  const theirCourses = (courses.data ?? []).filter((c) => (p.role === 'student' ? p.courseIds.includes(c.id) : c.instructor?.id === p.id));

  async function update(kind: 'status' | 'device', body: Parameters<typeof staffApi.updatePerson>[2], done: string) {
    setBusy(kind);
    setError(null);
    setInfo(null);
    try {
      const next = await staffApi.updatePerson(api, id, body);
      qc.setQueryData(['staff', 'person', id], next);
      void qc.invalidateQueries({ queryKey: ['staff'] });
      setInfo(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t update.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header title={p.fullName} subtitle={p.role} right={<Button title="Edit" kind="secondary" compact onPress={() => router.push({ pathname: '/person-form', params: { id } })} icon={<Pencil color={colors.text} size={14} />} />} />
      <Card style={{ alignItems: 'center', paddingVertical: 20, marginTop: 8 }}>
        <Avatar text={initials(p.fullName)} size={60} />
        <Text variant="heading" style={{ marginTop: 12 }}>
          {p.fullName}
        </Text>
        <Text variant="monoSmall" style={{ marginTop: 4 }}>
          {[p.rollNo, p.department, p.semester ? `Sem ${p.semester}` : null].filter(Boolean).join(' · ') || p.role}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <Badge label={p.role === 'admin' ? 'Admin' : p.role === 'teacher' ? 'Teacher' : 'Student'} tone={p.role === 'admin' ? 'violet' : 'cyan'} dot={false} />
          <Badge label={p.status === 'active' ? 'Active' : 'Suspended'} tone={p.status === 'active' ? 'green' : 'red'} />
        </View>
      </Card>
      {info ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="green" message={info} onDismiss={() => setInfo(null)} />
        </View>
      ) : null}
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} onDismiss={() => setError(null)} />
        </View>
      ) : null}

      <SectionLabel>Sign-in</SectionLabel>
      <Card>
        <InfoRow label="EMAIL" value={p.email ?? '—'} mono={false} />
        <InfoRow label="PHONE" value={p.phone ?? '—'} />
      </Card>

      <SectionLabel>Phone</SectionLabel>
      <Card style={{ gap: 12 }}>
        {p.device ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Smartphone color={colors.green} size={18} />
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong">{p.device.model}</Text>
                <Text variant="monoSmall">
                  HWID {p.device.fingerprint}
                  {p.device.boundAt ? ` · since ${dateLong(p.device.boundAt)}` : ''}
                </Text>
              </View>
            </View>
            <Button
              title="Unbind this phone"
              kind="danger"
              compact
              loading={busy === 'device'}
              disabled={self}
              onPress={() =>
                confirmAction(
                  'Unbind their phone?',
                  `${p.fullName} is signed out everywhere and binds a new phone at next sign-in. Use this when they lose or replace their phone.`,
                  'Unbind',
                  () => void update('device', { resetDevice: true }, 'Phone unbound. They can sign in on a new phone now.'),
                  true,
                )
              }
            />
          </>
        ) : (
          <Text variant="small">No phone bound yet — they bind one the first time they sign in.</Text>
        )}
      </Card>

      <SectionLabel>{p.role === 'student' ? 'Courses' : 'Teaches'}</SectionLabel>
      <Card>
        {theirCourses.length === 0 ? (
          <Text variant="small">{p.role === 'student' ? 'Not enrolled in any course.' : 'No courses assigned.'}</Text>
        ) : (
          theirCourses.map((c) => (
            <Text key={c.id} variant="body" style={{ paddingVertical: 4 }} onPress={() => router.push({ pathname: '/course/[id]', params: { id: c.id } })}>
              {c.code} · {c.title}
            </Text>
          ))
        )}
      </Card>

      {!self ? (
        p.status === 'active' ? (
          <Button
            title="Suspend account"
            kind="danger"
            loading={busy === 'status'}
            icon={<Ban color={colors.red} size={16} />}
            style={{ marginTop: 20 }}
            onPress={() =>
              confirmAction('Suspend this account?', `${p.fullName} is signed out immediately and can’t sign in until reactivated. Their records are kept.`, 'Suspend', () =>
                void update('status', { status: 'suspended' }, 'Account suspended.'), true)
            }
          />
        ) : (
          <Button title="Reactivate account" kind="secondary" loading={busy === 'status'} icon={<CheckCircle2 color={colors.text} size={16} />} style={{ marginTop: 20 }} onPress={() => void update('status', { status: 'active' }, 'Account reactivated.')} />
        )
      ) : (
        <Text variant="small" style={{ marginTop: 16 }}>
          This is you. Another admin must suspend or unbind your account.
        </Text>
      )}
    </Screen>
  );
}
