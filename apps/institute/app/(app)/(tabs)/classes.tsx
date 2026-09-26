import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { ChevronRight, ClipboardList, Plus, QrCode, Search } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Input, Loading, Text } from '@kit/components/ui';
import { colors } from '@kit/theme';
import { Empty } from '@/components/forms';
import { useCourses, useIsAdmin } from '@/queries';

/** Courses: admins see all of them, teachers see the ones they teach. */
export default function Classes() {
  const admin = useIsAdmin();
  const q = useCourses();
  const [search, setSearch] = useState('');
  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    const all = q.data ?? [];
    return s ? all.filter((c) => `${c.code} ${c.title} ${c.instructor?.name ?? ''}`.toLowerCase().includes(s)) : all;
  }, [q.data, search]);

  if (q.isPending) return <Screen scroll={false}><Loading /></Screen>;
  if (q.isError && !q.data)
    return (
      <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
        <View style={{ marginTop: 40 }}>
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        </View>
      </Screen>
    );

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Text variant="label" style={{ marginTop: 4 }}>
        {admin ? 'All courses' : 'Courses you teach'}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text variant="title" style={{ flex: 1, marginTop: 4 }}>
          Classes
        </Text>
        {admin ? <Button title="New course" compact onPress={() => router.push('/course-form')} icon={<Plus color="#03141c" size={16} />} /> : null}
      </View>
      {(q.data?.length ?? 0) > 6 ? (
        <View style={{ marginTop: 14 }}>
          <Input value={search} onChangeText={setSearch} placeholder="Search code, title or teacher" icon={<Search color={colors.textDim} size={16} />} autoCorrect={false} />
        </View>
      ) : null}
      <View style={{ gap: 10, marginTop: 14 }}>
        {list.length === 0 ? (
          <Empty
            title={q.data?.length ? 'No course matches' : admin ? 'No courses yet' : 'No courses assigned to you'}
            message={q.data?.length ? undefined : admin ? 'A course is one subject, e.g. “CS-301 Operating Systems”, taught by one teacher.' : 'Ask your admin to assign you as the teacher of a course.'}
            action={!q.data?.length && admin ? <Button title="Create the first course" onPress={() => router.push('/course-form')} /> : undefined}
          />
        ) : (
          list.map((c) => (
            <Pressable key={c.id} onPress={() => router.push({ pathname: '/course/[id]', params: { id: c.id } })} accessibilityRole="button">
              <Card style={[styles.row, !c.active && { opacity: 0.55 }]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.inline}>
                    <Text variant="monoSmall">{c.code}</Text>
                    {c.kind === 'lab' ? <Badge label="Lab" tone="violet" dot={false} /> : null}
                    {c.defaultMode === 'manual' ? <ClipboardList color={colors.violet} size={12} /> : <QrCode color={colors.textDim} size={12} />}
                    {!c.active ? <Badge label="Archived" tone="muted" dot={false} /> : null}
                  </View>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {c.title}
                  </Text>
                  <Text variant="small">
                    {c.studentCount} {c.studentCount === 1 ? 'student' : 'students'} · {c.instructor?.name ?? 'No teacher assigned'}
                  </Text>
                </View>
                <ChevronRight color={colors.textDim} size={18} />
              </Card>
            </Pressable>
          ))
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
