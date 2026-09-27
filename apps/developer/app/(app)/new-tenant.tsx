import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Building2 } from 'lucide-react-native';
import { CreateTenantBody } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Button, Card, Input, Notice, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { rootApi } from '@/api';
import { useConsole } from '@/queries';
import { Header, confirmIdentity } from '@/ui';

/** Onboard a new institution: it starts empty with its first admin. */
export default function NewTenant() {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [minAttendance, setMin] = useState('75');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sandbox = useConsole().data?.sandbox ?? false;
  /** A demo address signs in without a code while the server is in demo mode: handy for testing. */
  const testAddress = () => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30) || 'institution';
    setAdminEmail(`admin.${slug}@demo.attendly.app`);
    if (!adminName.trim()) setAdminName('Test Admin');
  };

  async function create() {
    setError(null);
    const parsed = CreateTenantBody.safeParse({ name, adminName, adminEmail, timezone, minAttendance: Number(minAttendance) });
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(`${i?.path.join('.') || 'form'}: ${i?.message ?? 'invalid'}`);
      return;
    }
    if (!(await confirmIdentity('Create an institution'))) return;
    setBusy(true);
    try {
      const t = await rootApi.createTenant(api, parsed.data);
      await qc.invalidateQueries({ queryKey: ['root'] });
      router.replace({ pathname: '/tenant/[id]', params: { id: t.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t create it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard>
      <Header title="New institution" subtitle="onboard a college" back />
      <Card style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Building2 color="#a78bfa" size={20} />
        <Text variant="small" style={{ flex: 1 }}>
          It starts empty with one admin, pending verification. Verify it on the next screen, then share its institution code: the admin enters it in Attendly Institute, signs in with this email and follows the setup checklist.
        </Text>
      </Card>
      {[
        { label: 'Institution name', value: name, set: setName, ph: 'e.g. Green Valley College' },
        { label: 'First admin’s name', value: adminName, set: setAdminName, ph: 'e.g. Dr. Anita Rao (Principal)' },
        { label: 'First admin’s email', value: adminEmail, set: setAdminEmail, ph: 'principal@greenvalley.edu', email: true },
        { label: 'Time zone', value: timezone, set: setTimezone, ph: 'Asia/Kolkata' },
        { label: 'Minimum attendance %', value: minAttendance, set: setMin, ph: '75', num: true },
      ].map((f) => (
        <View key={f.label} style={{ marginTop: 14 }}>
          <Text variant="label" style={{ marginBottom: 8 }}>
            {f.label}
          </Text>
          <Input value={f.value} onChangeText={f.set} placeholder={f.ph} autoCapitalize={f.email ? 'none' : 'words'} keyboardType={f.email ? 'email-address' : f.num ? 'number-pad' : 'default'} autoCorrect={false} />
        </View>
      ))}
      {sandbox ? (
        <Card tone="amber" style={{ marginTop: 14, gap: 10 }}>
          <Text variant="small">
            Testing without email? Give the admin an address ending in @demo.attendly.app: it signs in to Attendly Institute without a code while demo mode is on. A real address gets its code by email.
          </Text>
          <Button title="Use a test admin address" kind="ghost" compact onPress={testAddress} />
        </Card>
      ) : null}
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      <Button title="Create institution" onPress={() => void create()} loading={busy} style={{ marginTop: 18 }} />
    </Screen>
  );
}
