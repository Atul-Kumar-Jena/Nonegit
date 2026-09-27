import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Send, Undo2 } from 'lucide-react-native';
import type { BroadcastAudience, SupportAttribution } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, Input, Notice, SectionLabel, Segmented, Text } from '@kit/components/ui';
import { timeAgo } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, radius } from '@kit/theme';
import { rootApi } from '@/api';
import { useTenants } from '@/queries';
import { Header, confirmIdentity } from '@/ui';

const AUDIENCES: { key: BroadcastAudience; label: string }[] = [
  { key: 'everyone', label: 'Everyone' },
  { key: 'students', label: 'Students' },
  { key: 'admins', label: 'Admins' },
  { key: 'staff', label: 'Professors & admins' },
];
const CATEGORIES = [
  { key: 'general', label: '📢 General' },
  { key: 'academic', label: '📚 Academic' },
  { key: 'exam', label: '📝 Exam' },
  { key: 'event', label: '🎉 Event' },
  { key: 'holiday', label: '🌴 Holiday' },
] as const;

/** A message from Attendly to everyone, only students or only admins — in every institution or one. */
export default function BroadcastScreen() {
  const api = useApi();
  const qc = useQueryClient();
  const tenants = useTenants('');
  const [audience, setAudience] = useState<BroadcastAudience>('everyone');
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['key']>('general');
  const [important, setImportant] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [as, setAs] = useState<SupportAttribution>('support');
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const preview = useQuery({ queryKey: ['root', 'broadcast-preview', audience, tenantId], queryFn: () => rootApi.broadcastPreview(api, { audience, tenantId }) });
  const history = useQuery({ queryKey: ['root', 'broadcasts'], queryFn: () => rootApi.broadcasts(api) });
  const ready = title.trim().length > 0 && body.trim().length > 0 && (preview.data?.recipients ?? 0) > 0;

  async function send() {
    setError(null);
    if (!(await confirmIdentity('Send the broadcast'))) return;
    setBusy(true);
    try {
      const r = await rootApi.broadcast(api, { audience, tenantId, title: title.trim(), body: body.trim(), category, important, pinned, as });
      setDone(`Sent to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'} in ${r.institutions} ${r.institutions === 1 ? 'institution' : 'institutions'}.`);
      setTitle('');
      setBody('');
      setImportant(false);
      setPinned(false);
      setReview(false);
      void qc.invalidateQueries({ queryKey: ['root', 'broadcasts'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t send it.');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(id: string) {
    if (!(await confirmIdentity('Withdraw the broadcast'))) return;
    try {
      await rootApi.withdrawBroadcast(api, id);
      void qc.invalidateQueries({ queryKey: ['root', 'broadcasts'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t withdraw it.');
    }
  }

  const institutions = (tenants.data ?? []).filter((t) => t.status === 'active' && t.verified);

  return (
    <Screen>
      <Header title="Broadcast" subtitle="a message from Attendly" back />

      <SectionLabel>Send to</SectionLabel>
      <View style={styles.wrap}>
        {AUDIENCES.map((a) => (
          <Chip key={a.key} label={a.label} on={audience === a.key} onPress={() => setAudience(a.key)} />
        ))}
      </View>
      <Text variant="label" style={{ marginTop: 16, marginBottom: 8 }}>
        In
      </Text>
      <View style={styles.wrap}>
        <Chip label="All institutions" on={tenantId === null} onPress={() => setTenantId(null)} />
        {institutions.map((t) => (
          <Chip key={t.id} label={t.name} on={tenantId === t.id} onPress={() => setTenantId(t.id)} />
        ))}
      </View>
      <Card style={{ marginTop: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Megaphone color={colors.text} size={18} />
        <Text variant="body" style={{ flex: 1 }}>
          {preview.data ? `Reaches ${preview.data.recipients} ${preview.data.recipients === 1 ? 'person' : 'people'} · ${preview.data.label}` : 'Counting…'}
        </Text>
      </Card>

      <SectionLabel>Message</SectionLabel>
      <Input value={title} onChangeText={setTitle} placeholder="Title, e.g. Planned maintenance on Sunday" maxLength={120} />
      <Input
        value={body}
        onChangeText={setBody}
        placeholder="Write the message…"
        multiline
        maxLength={5000}
        style={{ minHeight: 140, textAlignVertical: 'top', marginTop: 10 }}
      />
      <View style={[styles.wrap, { marginTop: 12 }]}>
        {CATEGORIES.map((c) => (
          <Chip key={c.key} label={c.label} on={category === c.key} onPress={() => setCategory(c.key)} />
        ))}
      </View>
      <Card style={{ marginTop: 14, gap: 12 }}>
        <Toggle label="Important" detail="Shown in red; the notification says “Important”." value={important} onChange={setImportant} />
        <Toggle label="Pin to the top" detail="Stays above other notices until unpinned." value={pinned} onChange={setPinned} />
        <Text variant="label">Signed as</Text>
        <Segmented
          value={as}
          options={[
            { value: 'support', label: 'Attendly' },
            { value: 'named', label: 'My name' },
          ]}
          onChange={setAs}
        />
        <Text variant="small">Either way it’s recorded under your developer account.</Text>
      </Card>

      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} onDismiss={() => setError(null)} />
        </View>
      ) : null}
      {done ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="green" message={done} onDismiss={() => setDone(null)} />
        </View>
      ) : null}

      {review ? (
        <Card tone="amber" style={{ marginTop: 14, gap: 10 }}>
          <Text variant="bodyStrong">{`Send “${title.trim()}” to ${preview.data?.recipients ?? 0} people?`}</Text>
          <Text variant="small">{`${preview.data?.label ?? ''} · signed ${as === 'support' ? 'Attendly' : 'with your name'}. They get it in the app and as a phone notification.`}</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button title="Send now" onPress={() => void send()} loading={busy} icon={<Send color={colors.bg} size={16} />} style={{ flex: 1 }} />
            <Button title="Back" kind="ghost" onPress={() => setReview(false)} />
          </View>
        </Card>
      ) : (
        <Button title="Review & send" onPress={() => setReview(true)} disabled={!ready} style={{ marginTop: 16 }} />
      )}

      <SectionLabel>Sent</SectionLabel>
      <Card style={{ gap: 14 }}>
        {history.data?.length === 0 ? <Text variant="small">No broadcasts yet.</Text> : null}
        {(history.data ?? []).map((b) => (
          <View key={b.id} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text variant="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>
                {b.title}
              </Text>
              {b.important ? <Badge label="Important" tone="red" dot={false} /> : null}
            </View>
            <Text variant="small">{`${b.audienceLabel} · ${b.institutions} ${b.institutions === 1 ? 'institution' : 'institutions'} · ${b.signedAs} · ${timeAgo(b.createdAt)}`}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text variant="small" style={{ flex: 1 }}>{`Seen by ${b.seen} of ${b.recipients}`}</Text>
              <Button title="Withdraw" kind="ghost" compact onPress={() => void withdraw(b.id)} icon={<Undo2 color={colors.text} size={14} />} />
            </View>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]}>
      <Text variant="small" color={on ? colors.bg : colors.text} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function Toggle({ label, detail, value, onChange }: { label: string; detail: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong">{label}</Text>
        <Text variant="small">{detail}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.text, false: colors.border }} thumbColor={value ? colors.bg : colors.textMuted} accessibilityLabel={label} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill ?? 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, maxWidth: '100%' },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
});
