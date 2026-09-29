import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { UpdateInstitutionBody } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Button, Card, InfoRow, Input, Loading, Notice, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { staffApi } from '@/api';
import { Chips, DateField, Field, Header, Select, firstIssue } from '@/components/forms';
import { useInstitution, useIsAdmin, useMe } from '@/queries';
import { markInstitutionReviewed } from '@/setup';

const ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Dhaka',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Colombo',
  'Europe/London',
  'Europe/Berlin',
  'Africa/Nairobi',
  'Africa/Lagos',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];
const MINIMUMS = [60, 65, 70, 75, 80, 85, 90].map((v) => ({ value: v, label: `${v}%` }));
const RESETS = [0, 1, 2, 3, 5].map((v) => ({ value: v, label: String(v) }));

/** Institution-wide settings (the main admin edits; everyone else can read). */
export default function Institution() {
  const api = useApi();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const owner = useMe().data?.owner ?? false;
  const admin = isAdmin && owner;
  const q = useInstitution();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [minAttendance, setMin] = useState(75);
  const [termName, setTermName] = useState('');
  const [termStart, setTermStart] = useState('2026-01-01');
  const [domains, setDomains] = useState('');
  const [deviceResetLimit, setResets] = useState(2);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const i = q.data;
    if (!i || loaded) return;
    setName(i.name);
    setTimezone(i.timezone);
    setMin(i.minAttendance);
    setTermName(i.termName);
    setTermStart(i.termStart);
    setDomains(i.emailDomains.join(', '));
    setResets(i.deviceResetLimit);
    setLoaded(true);
  }, [q.data, loaded]);

  if (!loaded) return <Screen scroll={false}><Header title="Institution" />{q.isPending ? <Loading /> : <Notice tone="red" message={q.error?.message ?? 'Couldn’t load settings.'} />}</Screen>;

  if (!admin) {
    const i = q.data!;
    return (
      <Screen>
        <Header title="Institution" />
        <Card>
          <InfoRow label="NAME" value={i.name} mono={false} />
          <InfoRow label="TIME ZONE" value={i.timezone} />
          <InfoRow label="TERM" value={`${i.termName} · from ${i.termStart}`} mono={false} />
          <InfoRow label="MINIMUM" value={`${i.minAttendance}%`} />
        </Card>
        <Text variant="small" style={{ marginTop: 12 }}>
          {isAdmin ? 'Only the main admin can change these — ask them, or they can hand the main-admin role over.' : 'Only the main admin can change these.'}
        </Text>
      </Screen>
    );
  }

  async function save() {
    setError(null);
    setSaved(false);
    const parsed = UpdateInstitutionBody.safeParse({
      name,
      timezone,
      minAttendance,
      termName,
      termStart,
      emailDomains: domains
        .split(/[\s,;]+/)
        .map((d) => d.trim().replace(/^@/, ''))
        .filter(Boolean),
      deviceResetLimit,
    });
    if (!parsed.success) return setError(firstIssue(parsed.error));
    setBusy(true);
    try {
      const next = await staffApi.updateInstitution(api, parsed.data);
      qc.setQueryData(['staff', 'institution'], next);
      void qc.invalidateQueries({ queryKey: ['staff'] });
      await markInstitutionReviewed();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard>
      <Header title="Institution" />
      <Field label="Name">
        <Input value={name} onChangeText={setName} maxLength={120} />
      </Field>
      <Field label="Time zone" hint="Class times and “today” are in this zone for everyone.">
        <Select title="Time zone" value={timezone} onChange={(v) => v && setTimezone(v)} options={(ZONES.includes(timezone) ? ZONES : [timezone, ...ZONES]).map((z) => ({ value: z, label: z }))} />
      </Field>
      <Field label="Term name">
        <Input value={termName} onChangeText={setTermName} placeholder="Odd semester 2026" maxLength={60} />
      </Field>
      <Field label="Term starts" hint="Attendance percentages count classes from this date.">
        <DateField value={termStart} onChange={setTermStart} />
      </Field>
      <Field label="Minimum attendance">
        <Chips value={minAttendance} options={MINIMUMS.some((m) => m.value === minAttendance) ? MINIMUMS : [{ value: minAttendance, label: `${minAttendance}%` }, ...MINIMUMS]} onChange={setMin} />
      </Field>
      <Field label="Phone resets allowed per student per term">
        <Chips value={deviceResetLimit} options={RESETS} onChange={setResets} />
      </Field>
      <Field label="Institution email domains (optional)" hint="For reference, e.g. college.edu. Anyone you add can sign in, whatever their email.">
        <Input value={domains} onChangeText={setDomains} placeholder="college.edu, students.college.edu" autoCapitalize="none" autoCorrect={false} />
      </Field>
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      {saved ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="green" message="Saved. Every app picks this up on its next refresh." onDismiss={() => setSaved(false)} />
        </View>
      ) : null}
      <Button title="Save settings" onPress={() => void save()} loading={busy} style={{ marginTop: 18 }} />
    </Screen>
  );
}
