import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, LocateFixed, MapPin, Plus } from 'lucide-react-native';
import { RoomBody, type Room } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Input, Loading, Notice, Text } from '@kit/components/ui';
import { getFreshFix } from '@kit/lib/location';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { Chips, Empty, Field, Header, Sheet, ToggleRow, firstIssue } from '@/components/forms';
import { useIsAdmin, useRooms } from '@/queries';

const RADII = [
  { value: 25, label: '25 m' },
  { value: 50, label: '50 m' },
  { value: 75, label: '75 m' },
  { value: 100, label: '100 m' },
  { value: 150, label: '150 m' },
] as const;

/** Classrooms and their saved locations (the geofence QR classes use). */
export default function Rooms() {
  const admin = useIsAdmin();
  const q = useRooms();
  const [editing, setEditing] = useState<Room | 'new' | null>(null);

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header info="rooms" title="Rooms" right={admin ? <Button title="Add" compact onPress={() => setEditing('new')} icon={<Plus color="#0a0a0a" size={15} />} /> : undefined} />
      <Text variant="small">Stand inside the room and tap “Use my location” to save it. QR classes in this room then only accept scans from inside the circle.</Text>
      <View style={{ gap: 10, marginTop: 14 }}>
        {q.isPending ? (
          <Loading />
        ) : q.isError && !q.data ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : (q.data ?? []).length === 0 ? (
          <Empty title="No rooms yet" message="Add each classroom or lab once." action={admin ? <Button title="Add a room" onPress={() => setEditing('new')} /> : undefined} />
        ) : (
          (q.data ?? []).map((r) => (
            <Pressable key={r.id} disabled={!admin} onPress={() => setEditing(r)} accessibilityRole="button">
              <Card style={[styles.row, !r.active && { opacity: 0.55 }]}>
                <MapPin color={r.lat !== null ? colors.green : colors.amber} size={18} />
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{r.name}</Text>
                  <Text variant="monoSmall">{r.lat !== null ? `${r.lat.toFixed(5)}, ${r.lng!.toFixed(5)} · ${r.radiusM} m` : 'Location not saved'}</Text>
                </View>
                {!r.active ? <Badge label="Hidden" tone="muted" dot={false} /> : null}
                {admin ? <ChevronRight color={colors.textDim} size={16} /> : null}
              </Card>
            </Pressable>
          ))
        )}
      </View>
      {editing ? <RoomSheet room={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Screen>
  );
}

function RoomSheet({ room, onClose }: { room: Room | null; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState(room?.name ?? '');
  const [lat, setLat] = useState<number | null>(room?.lat ?? null);
  const [lng, setLng] = useState<number | null>(room?.lng ?? null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [radiusM, setRadius] = useState(room?.radiusM ?? 50);
  const [active, setActive] = useState(room?.active ?? true);
  const [busy, setBusy] = useState<null | 'gps' | 'save'>(null);
  const [error, setError] = useState<string | null>(null);

  async function locate() {
    setBusy('gps');
    setError(null);
    try {
      const fix = await getFreshFix(25_000);
      if (fix.mocked) throw new Error('This phone reports a mock location. Turn off mock-location apps and try again.');
      setLat(Math.round(fix.lat * 1e6) / 1e6);
      setLng(Math.round(fix.lng * 1e6) / 1e6);
      setAccuracy(Math.round(fix.accuracyM));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t get a location.');
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setError(null);
    const parsed = RoomBody.safeParse({ name, lat, lng, radiusM, active });
    if (!parsed.success) return setError(firstIssue(parsed.error));
    setBusy('save');
    try {
      await staffApi.saveRoom(api, room?.id ?? null, parsed.data);
      void qc.invalidateQueries({ queryKey: ['staff'] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet open onClose={onClose} title={room ? 'Edit room' : 'New room'}>
      <Field label="Name" hint="Unique, e.g. “LH-204” or “Physics Lab 2”.">
        <Input value={name} onChangeText={setName} placeholder="LH-204" maxLength={60} />
      </Field>
      <Field label="Location">
        <Button title={lat !== null ? 'Update to my location' : 'Use my location'} kind="secondary" onPress={() => void locate()} loading={busy === 'gps'} icon={<LocateFixed color={colors.text} size={16} />} />
      </Field>
      {lat !== null ? (
        <Text variant="monoSmall" style={{ marginTop: 8 }}>
          {lat.toFixed(6)}, {lng?.toFixed(6)}
          {accuracy !== null ? ` · ±${accuracy} m` : ''}
        </Text>
      ) : null}
      {accuracy !== null && accuracy > 40 ? <Text variant="small" color={colors.amber} style={{ marginTop: 4 }}>Weak GPS (±{accuracy} m). Move near a window and try again for a better fix.</Text> : null}
      <Field label="Allowed distance">
        <Chips value={radiusM} options={RADII} onChange={setRadius} />
      </Field>
      {room ? <ToggleRow label="Active" hint="Hidden rooms can’t be picked for new classes." value={active} onChange={setActive} /> : null}
      {error ? (
        <View style={{ marginTop: 10 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      <Button title="Save room" onPress={() => void save()} loading={busy === 'save'} disabled={!name.trim()} style={{ marginTop: 16 }} />
    </Sheet>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 12 } });
