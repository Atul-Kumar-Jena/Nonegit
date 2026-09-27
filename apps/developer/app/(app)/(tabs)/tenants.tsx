import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Plus, Search } from 'lucide-react-native';
import type { TenantSummary } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Avatar, Badge, Button, Card, ErrorState, Input, Loading, Text } from '@kit/components/ui';
import { initials } from '@kit/lib/format';
import { colors } from '@kit/theme';
import { useConsole, useTenants } from '@/queries';
import { Header, fmtNum } from '@/ui';

/** 04 Tenants — every institution on this server. */
export default function TenantsScreen() {
  const [q, setQ] = useState('');
  const list = useTenants(q.trim());
  const sandbox = useConsole().data?.sandbox ?? true;
  const all = list.data ?? [];
  const totals = all.reduce((a, t) => ({ users: a.users + t.students + t.teachers + t.admins, live: a.live + t.liveSessions }), { users: 0, live: 0 });
  return (
    <Screen onRefresh={() => void list.refetch()} refreshing={list.isRefetching}>
      <Header
        title="Institutions"
        subtitle={`${all.length} tenants · ${fmtNum(totals.users)} users · ${totals.live} live`}
        right={!sandbox ? <Button title="New" compact onPress={() => router.push('/new-tenant')} icon={<Plus color="#03141c" size={15} />} /> : undefined}
      />
      <Input value={q} onChangeText={setQ} placeholder="Search institutions…" icon={<Search color={colors.textDim} size={16} />} autoCapitalize="none" />
      <View style={{ gap: 10, marginTop: 14 }}>
        {list.isPending ? <Loading /> : null}
        {list.isError ? <ErrorState message={list.error.message} onRetry={() => void list.refetch()} /> : null}
        {all.map((t) => (
          <TenantCard key={t.id} t={t} />
        ))}
        {!list.isPending && all.length === 0 ? <Text variant="small">No institutions match.</Text> : null}
      </View>
      {sandbox ? (
        <Text variant="small" style={{ marginTop: 14 }}>
          Sandbox: only the demo institute is shown. A real developer account can add institutions (each gets its first admin, who sets up the rest in Attendly Institute).
        </Text>
      ) : null}
    </Screen>
  );
}

function TenantCard({ t }: { t: TenantSummary }) {
  return (
    <Pressable onPress={() => router.push({ pathname: '/tenant/[id]', params: { id: t.id } })} accessibilityRole="button" accessibilityLabel={`${t.name}, ${t.status}`}>
      <Card style={{ gap: 10, opacity: t.status === 'suspended' ? 0.7 : 1 }}>
        <View style={styles.row}>
          <Avatar text={initials(t.name)} size={40} />
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {t.name}
            </Text>
            <Text variant="monoSmall">tenant:{t.slug}</Text>
          </View>
          {t.demo ? <Badge label="Demo" tone="amber" dot={false} /> : null}
          {t.verified ? <Badge label="Verified" tone="green" dot={false} /> : <Badge label="Pending verification" tone="amber" dot={false} />}
          <Badge label={t.status === 'active' ? 'Active' : 'Suspended'} tone={t.status === 'active' ? 'green' : 'red'} />
        </View>
        <View style={styles.row}>
          <Mini label="Students" value={fmtNum(t.students)} />
          <Mini label="Staff" value={fmtNum(t.teachers + t.admins)} />
          <Mini label="Live" value={String(t.liveSessions)} />
          <Mini label="Scans 24h" value={fmtNum(t.scansToday)} />
        </View>
        {t.statusReason ? <Text variant="small">Suspended: {t.statusReason}</Text> : null}
      </Card>
    </Pressable>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text variant="label">{label}</Text>
      <Text variant="bodyStrong">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});

