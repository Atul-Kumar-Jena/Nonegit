import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, LocateFixed, MapPin, Plus } from 'lucide-react-native';
import { RoomBody, type Room } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, Input, Loading, Notice, Text } from '@kit/components/ui';
import { getPreciseFix } from '@kit/lib/location';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { Chips, Empty, Field, Header, Sheet, ToggleRow, firstIssue, RadiusField } from '@/components/forms';
import { useCan, useRooms } from '@/queries';


/** Classrooms and their saved locations (the geofence QR classes use). */
export default function Rooms() {
  const admin = useCan('courses');
  const q = useRooms();
  const [editing, setEditing] = useState<Room | 'new' | null>(null);

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching} fab={admin ? { label: 'Add room', icon: <Plus color={colors.ink} size={18} />, onPress: () => setEditing('new') } : null}>
      <Header info="rooms" title="Rooms" />
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
                  <Text variant="small">{r.lat !== null ? [`Location saved`, r.centerAccuracyM !== null ? `±${Math.round(r.centerAccuracyM)} m` : null, `${r.radiusM} m radius`].filter(Boolean).join(' · ') : 'Location not saved'}</Text>
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
  const [accuracy, setAccuracy] = useState<number | null>(room?.centerAccuracyM ?? null);
  const [radiusM, setRadius] = useState(room?.radiusM ?? 50);
  const [active, setActive] = useState(room?.active ?? true);
  const [busy, setBusy] = useState<null | 'gps' | 'save'>(null);
  const [error, setError] = useState<string | null>(null);
  /** Every measurement taken now: combined, weighted by how precise each was (better with each one). */
  const [fixes, setFixes] = useState<{ lat: number; lng: number; accuracyM: number }[]>([]);
  const [radiusTouched, setRadiusTouched] = useState(!!room);

  async function locate(add: boolean) {
    setBusy('gps');
    setError(null);
    try {
      // Averaged over several seconds: stand in the middle of the room and keep still.
      const fix = await getPreciseFix({ maxWaitMs: 10_000, timeoutMs: 25_000 });
      if (fix.mocked) throw new Error('This phone reports a mock location. Turn off mock-location apps and try again.');
      const all = [...(add ? fixes : []), { lat: fix.lat, lng: fix.lng, accuracyM: Math.max(1, fix.accuracyM) }];
      setFixes(all);
      // Inverse-variance average: precise fixes count more; the combined spread shrinks with each one.
      let w = 0;
      let la = 0;
      let lo = 0;
      for (const f of all) {
        const k = 1 / (f.accuracyM * f.accuracyM);
        w += k;
        la += f.lat * k;
        lo += f.lng * k;
      }
      const acc = Math.max(Math.min(...all.map((f) => f.accuracyM)) / Math.sqrt(all.length), Math.sqrt(1 / w));
      setLat(Math.round((la / w) * 1e6) / 1e6);
      setLng(Math.round((lo / w) * 1e6) / 1e6);
      setAccuracy(Math.round(acc * 10) / 10);
      // A radius that fits: the room itself plus what indoor GPS can't tell apart.
      if (!radiusTouched) setRadius(suggestRadius(acc));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t get a location.');
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setError(null);
    if (lat !== null && accuracy !== null && accuracy > radiusM)
      return setError(`The location is only accurate to ±${Math.round(accuracy)} m but the allowed distance is ${radiusM} m — add a measurement or raise the distance.`);
    const parsed = RoomBody.safeParse({ name, lat, lng, radiusM, active, centerAccuracyM: lat === null ? null : accuracy });
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
      <Field label="Location" hint="Stand in the middle of the room, keep still ~10 s. Measure 2–3 times (e.g. near the board and the back) for a sharper centre.">
        <View style={{ gap: 8 }}>
          <Button
            title={lat !== null && fixes.length === 0 ? 'Measure again here' : fixes.length ? 'Start over here' : 'Use my location'}
            kind="secondary"
            onPress={() => void locate(false)}
            loading={busy === 'gps'}
            icon={<LocateFixed color={colors.text} size={16} />}
          />
          {fixes.length > 0 && fixes.length < 5 ? (
            <Button title={`Add another measurement (${fixes.length} so far)`} kind="ghost" compact onPress={() => void locate(true)} disabled={busy === 'gps'} />
          ) : null}
        </View>
      </Field>
      {lat !== null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <Text variant="small" style={{ flex: 1 }}>
            {accuracy !== null ? `Centre ${fixes.length ? `from ${fixes.length} ${fixes.length === 1 ? 'measurement' : 'measurements'}` : 'saved'} · ±${accuracy} m` : 'Centre saved'}
          </Text>
          <Button title="Check on map" kind="ghost" compact onPress={() => void Linking.openURL(`geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(name || 'Room')})`).catch(() => Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`))} />
        </View>
      ) : null}
      {accuracy !== null && accuracy > 30 ? (
        <Text variant="small" color={colors.amber} style={{ marginTop: 4 }}>
          {`Weak GPS (±${accuracy} m) — students near the walls may be refused. Step near a window or door, or add another measurement.`}
        </Text>
      ) : null}
      <Field label="Allowed distance" hint={accuracy !== null ? `Suggested for this reading: ${suggestRadius(accuracy)} m (the room plus indoor GPS error).` : 'Small classroom 20–30 m · lecture hall 30–50 m · auditorium or ground 75–100 m.'}>
        <RadiusField
          value={radiusM}
          onChange={(m) => {
            setRadiusTouched(true);
            setRadius(m);
          }}
        />
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

/** Room radius from the centre's precision: never tighter than 20 m (indoor GPS), rounded to 5 m. */
function suggestRadius(accuracyM: number): number {
  return Math.min(150, Math.max(20, Math.ceil((15 + accuracyM * 1.5) / 5) * 5));
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 12 } });
