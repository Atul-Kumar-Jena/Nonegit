import { useEffect, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react-native';
import type { Person } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Avatar, Badge, ErrorState, Input, Loading, Segmented, Text } from '@kit/components/ui';
import { initials } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { rootApi } from '@/api';
import { Header } from '@/ui';

/** Support: an institution's students and staff. Tap someone to see and manage their account. */
export default function TenantPeople() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const api = useApi();
  const [role, setRole] = useState<'student' | 'staff'>('student');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useQuery({ queryKey: ['root', 'people', id, role, debounced], queryFn: () => rootApi.people(api, String(id), role, debounced || undefined) });

  return (
    <Screen scroll={false} keyboard>
      <Header title="People" subtitle={name ? String(name) : 'institution'} back />
      <Segmented
        value={role}
        options={[
          { value: 'student', label: 'Students' },
          { value: 'staff', label: 'Professors & admins' },
        ]}
        onChange={setRole}
      />
      <View style={{ marginTop: 12 }}>
        <Input value={q} onChangeText={setQ} placeholder="Search name, roll no., email or phone" icon={<Search color={colors.textDim} size={16} />} autoCapitalize="none" autoCorrect={false} />
      </View>
      {list.isPending ? <Loading /> : null}
      {list.isError ? <ErrorState message={list.error.message} onRetry={() => void list.refetch()} /> : null}
      <FlatList
        style={{ flex: 1, marginTop: 12 }}
        contentContainerStyle={{ gap: 8, paddingBottom: 40 }}
        data={list.data ?? []}
        keyExtractor={(p) => p.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={list.isSuccess ? <Text variant="small">No one matches.</Text> : null}
        renderItem={({ item }) => <Row p={item} tenantId={String(id)} />}
      />
    </Screen>
  );
}

function Row({ p, tenantId }: { p: Person; tenantId: string }) {
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/tenant/person', params: { tid: tenantId, pid: p.id } })}
      accessibilityRole="button"
      accessibilityLabel={p.fullName}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: pressed ? colors.cardHi : colors.card })}
    >
      <Avatar text={initials(p.fullName)} size={38} />
      <View style={{ flex: 1, gap: 3 }}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {p.fullName}
        </Text>
        <Text variant="small" numberOfLines={1}>
          {[p.rollNo, p.email ?? p.phone].filter(Boolean).join(' · ')}
        </Text>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {p.owner ? <Badge label="Main admin" tone="violet" dot={false} /> : p.role === 'admin' ? <Badge label="Admin" tone="violet" dot={false} /> : p.role === 'teacher' ? <Badge label="Professor" tone="muted" dot={false} /> : null}
          {p.status === 'suspended' ? <Badge label="Suspended" tone="red" dot={false} /> : p.device ? <Badge label="Phone linked" tone="green" dot={false} /> : <Badge label="No phone" tone="muted" dot={false} />}
        </View>
      </View>
      <ChevronRight color={colors.textDim} size={18} />
    </Pressable>
  );
}
