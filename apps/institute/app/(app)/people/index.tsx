import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronRight, FileUp, Search, UserPlus } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Input, Loading, Notice, Segmented, Text } from '@kit/components/ui';
import { colors, radius } from '@kit/theme';
import { Header } from '@/components/forms';
import { useIsAdmin, usePeople } from '@/queries';

type Role = 'student' | 'teacher' | 'admin';

/** Everyone in the institution (admins): search, add one, or paste a whole class list. */
export default function People() {
  const params = useLocalSearchParams<{ role?: string }>();
  const [role, setRole] = useState<Role>(params.role === 'teacher' || params.role === 'admin' ? params.role : 'student');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = usePeople({ role, q: debounced || undefined });
  const isAdmin = useIsAdmin();

  return (
    <Screen scroll={false} keyboard>
      <Header info="people"
        title="People & roles"
        right={role !== 'admin' || isAdmin ? <Button title="Add" compact onPress={() => router.push({ pathname: '/person-form', params: { role } })} icon={<UserPlus color={colors.bg} size={15} />} /> : undefined}
      />
      <Segmented
        value={role}
        options={[
          { value: 'student', label: 'Students' },
          { value: 'teacher', label: 'Professors' },
          { value: 'admin', label: 'Admins' },
        ]}
        onChange={setRole}
      />
      <View style={{ marginTop: 12 }}>
        <Input value={q} onChangeText={setQ} placeholder="Search name, roll no., email or phone" icon={<Search color={colors.textDim} size={16} />} autoCorrect={false} autoCapitalize="none" />
      </View>
      {role !== 'admin' ? (
        <Pressable onPress={() => router.push({ pathname: '/import', params: { role } })} accessibilityRole="button" style={styles.import}>
          <FileUp color={colors.cyan} size={16} />
          <Text variant="small" color={colors.cyan} style={{ flex: 1 }}>
            Add many at once — paste from a spreadsheet
          </Text>
        </Pressable>
      ) : null}
      {list.isError && !list.data ? <Notice tone="red" message={list.error.message} /> : null}
      <FlatList
        style={{ flex: 1, marginTop: 6 }}
        data={list.data ?? []}
        keyExtractor={(p) => p.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <Pressable onPress={() => router.push({ pathname: '/people/[id]', params: { id: item.id } })} accessibilityRole="button" style={[styles.row, item.status === 'suspended' && { opacity: 0.55 }]}>
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {item.fullName}
              </Text>
              <Text variant="monoSmall" numberOfLines={1}>
                {[item.rollNo, item.email ?? item.phone].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {item.role === 'teacher' && item.permissions.length ? <Badge label={`+${item.permissions.length}`} tone="muted" dot={false} /> : null}
            {item.status === 'suspended' ? <Badge label="Suspended" tone="red" dot={false} /> : item.device ? <Badge label="Phone bound" tone="green" dot={false} /> : <Badge label="Not signed in" tone="muted" dot={false} />}
            <ChevronRight color={colors.textDim} size={16} />
          </Pressable>
        )}
        ListEmptyComponent={
          list.isPending ? (
            <Loading />
          ) : (
            <Text variant="small" style={{ padding: 16 }}>
              {debounced ? 'No one matches.' : `No ${role}s yet. Tap “Add”${role !== 'admin' ? ' or paste a list' : ''}.`}
            </Text>
          )
        }
        ListFooterComponent={(list.data?.length ?? 0) >= 1000 ? <Text variant="small" style={{ padding: 12 }}>Showing the first 1000 — search to narrow down.</Text> : null}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  import: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 6, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
});
