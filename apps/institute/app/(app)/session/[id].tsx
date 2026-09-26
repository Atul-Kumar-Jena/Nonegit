import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, ClipboardList, CloudOff, MapPin, Monitor, QrCode, ShieldAlert, UserRound, XCircle } from 'lucide-react-native';
import { randomToken, type FeedEntry, type SessionMode, type StartSessionBody } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, ErrorState, InfoRow, Loading, Notice, SectionLabel, Text } from '@kit/components/ui';
import { ApiRequestError } from '@kit/lib/api-core';
import { dayLabel, timeAgo, timeRange, zoned, clock } from '@kit/lib/format';
import { LocationError, getFreshFix } from '@kit/lib/location';
import { outbox } from '@kit/lib/outbox';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { staffApi } from '@/api';
import { AdjustSheet } from '@/components/Adjust';
import { CoverSheet } from '@/components/Requests';
import { BigScreenSheet } from '@/components/BigScreen';
import { Chips, Field, Header, confirmAction } from '@/components/forms';
import { StatusBadge } from '@/components/SessionCard';
import { localSessions } from '@/local-sessions';
import { qk, useFeed, useIsAdmin, useMe } from '@/queries';
import { useSessionView } from '@/session-view';
import { TEACHER_EDIT_WINDOW_MS, canStartNow, minutesLabel } from '@/time';

const RADII = [
  { value: 25, label: '25 m' },
  { value: 50, label: '50 m' },
  { value: 75, label: '75 m' },
  { value: 100, label: '100 m' },
  { value: 150, label: '150 m' },
] as const;
const ROTATIONS = [
  { value: 5, label: '5 s' },
  { value: 7, label: '7 s' },
  { value: 10, label: '10 s' },
  { value: 15, label: '15 s' },
] as const;

const offline = (e: unknown) => e instanceof ApiRequestError && (e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.status >= 500);

/** One class: start it (QR or register), watch it live, end it, or review it afterwards. */
export default function SessionScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = String(rawId ?? '');
  const api = useApi();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const { session: s, secret, tz, query, fromCache } = useSessionView(id);
  const feed = useFeed(id, s?.status === 'live');

  const [mode, setMode] = useState<SessionMode | null>(null);
  const [where, setWhere] = useState<'phone' | 'room' | null>(null);
  const [radius, setRadius] = useState<number | null>(null);
  const [rotation, setRotation] = useState<number | null>(null);
  const [busy, setBusy] = useState<null | 'start' | 'end'>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [bigScreen, setBigScreen] = useState(false);
  const [adjust, setAdjust] = useState<null | 'reschedule' | 'substitute' | 'cancel'>(null);
  const me = useMe();

  if (!s) {
    if (query.isPending) return <Screen scroll={false}><Header title="Class" /><Loading /></Screen>;
    return (
      <Screen>
        <Header title="Class" />
        <ErrorState message={query.error?.message ?? 'This class isn’t available offline. Connect to the internet and try again.'} onRetry={() => void query.refetch()} />
      </Screen>
    );
  }

  const now = api.serverNow();
  const canReorganise = isAdmin || (!!me.data && s.teacher?.id === me.data.user.id);
  const m: SessionMode = mode ?? s.mode;
  const roomHasLocation = s.lat !== null && s.lng !== null && s.status === 'scheduled';
  const w = where ?? 'phone';
  const r = radius ?? s.radiusM;
  const rot = rotation ?? s.rotationS;
  const startable = canStartNow(s, now);
  const startsIn = Date.parse(s.scheduledStart) - now;
  const canEditRegister = s.status !== 'cancelled' && (isAdmin || now - Date.parse(s.scheduledEnd) <= TEACHER_EDIT_WINDOW_MS) && Date.parse(s.scheduledStart) - now <= 30 * 60_000;

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['staff'] });
  }

  async function start() {
    setBusy('start');
    setError(null);
    setInfo(null);
    const clientRef = randomToken(12);
    try {
      let lat: number | null = null;
      let lng: number | null = null;
      if (m === 'qr' && (w === 'phone' || !roomHasLocation)) {
        try {
          const fix = await getFreshFix(20_000);
          if (fix.mocked) throw new LocationError('unavailable', 'This phone reports a mock location. Turn off mock-location apps to start a QR class.');
          lat = fix.lat;
          lng = fix.lng;
        } catch (err) {
          if (!roomHasLocation) throw err;
          setInfo('Couldn’t get this phone’s location — using the room’s saved location instead.');
        }
      }
      const body: StartSessionBody = { mode: m, ...(lat !== null ? { lat, lng } : {}), radiusM: r, rotationS: rot, clientRef };
      try {
        const res = await staffApi.start(api, s!.id, body);
        qc.setQueryData(qk.session(s!.id), res);
        refresh();
      } catch (err) {
        if (!offline(err)) throw err;
        if (m === 'qr' && !secret)
          throw new Error('You’re offline and this class’s QR key wasn’t downloaded to this phone. Use the paper-style register instead, or connect once.');
        const startedAt = api.serverNow();
        await outbox.enqueue('session.start', `${s!.courseCode} · class started`, { sessionId: s!.id, body: { ...body, startedAt } });
        await localSessions.put({
          sessionId: s!.id,
          status: 'live',
          mode: m,
          startedAt,
          endedAt: null,
          rotationS: rot,
          secret: m === 'qr' ? secret : null,
          courseCode: s!.courseCode,
          courseTitle: s!.courseTitle,
        });
      }
      router.push(m === 'qr' ? { pathname: '/live/[id]', params: { id: s!.id } } : { pathname: '/register/[id]', params: { id: s!.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t start the class.');
    } finally {
      setBusy(null);
    }
  }

  function end() {
    confirmAction('End this class?', 'Students can’t scan after this. You can still correct the register later.', 'End class', async () => {
      setBusy('end');
      setError(null);
      const body = { clientRef: randomToken(12) };
      try {
        await staffApi.end(api, s!.id, body);
        refresh();
      } catch (err) {
        if (offline(err)) {
          const endedAt = api.serverNow();
          await outbox.enqueue('session.end', `${s!.courseCode} · class ended`, { sessionId: s!.id, body: { ...body, endedAt } });
          if (localSessions.get(s!.id)) await localSessions.patch(s!.id, { status: 'closed', endedAt });
          else
            await localSessions.put({
              sessionId: s!.id,
              status: 'closed',
              mode: s!.mode,
              startedAt: s!.startedAt ? Date.parse(s!.startedAt) : endedAt,
              endedAt,
              rotationS: s!.rotationS,
              secret: null,
              courseCode: s!.courseCode,
              courseTitle: s!.courseTitle,
            });
          setInfo('You’re offline — the class is ended on this phone and will sync automatically.');
        } else setError(err instanceof Error ? err.message : 'Couldn’t end the class.');
      } finally {
        setBusy(null);
      }
    });
  }

  const entries = feed.data?.entries ?? [];
  const present = entries.filter((e) => e.present);
  const absent = entries.filter((e) => !e.present);
  const flags = (feed.data?.flags ?? []).filter((f) => f.status === 'open');

  return (
    <Screen onRefresh={() => { void query.refetch(); void feed.refetch(); }} refreshing={query.isRefetching}>
      <Header title={s.courseCode} subtitle={dayLabel(s.scheduledStart, tz)} right={<StatusBadge s={s} />} />
      <Text variant="title" style={{ marginTop: 6 }}>
        {s.courseTitle}
      </Text>
      <Text variant="small" style={{ marginTop: 4 }}>
        {[timeRange(s.scheduledStart, s.scheduledEnd, tz), s.room?.name ?? s.roomLabel, s.lectureNo ? `Lecture ${s.lectureNo}` : null, `code ${s.code}`].filter(Boolean).join(' · ')}
      </Text>
      {s.substitute || s.change ? (
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {s.substitute ? <Badge label={`Taken by ${s.substitute.name}`} tone="violet" dot={false} /> : null}
          {s.change?.kind === 'rescheduled' ? <Badge label={`Moved${s.change.originalStart ? ` from ${zoned(s.change.originalStart, tz).dow} ${clock(s.change.originalStart, tz)}` : ''}`} tone="amber" dot={false} /> : null}
          {s.change?.kind === 'extra' ? <Badge label="Extra class" tone="green" dot={false} /> : null}
          {s.change?.kind === 'cancelled' && s.change.note ? <Badge label={`Reason: ${s.change.note}`} tone="red" dot={false} /> : null}
        </View>
      ) : null}

      {fromCache ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="violet" message="Offline — showing the copy saved on this phone. Everything you do here syncs when you’re back online." />
        </View>
      ) : null}
      {s.pendingSync ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="violet" message="Changes made offline are waiting to upload. They sync automatically." />
        </View>
      ) : null}
      {info ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="cyan" message={info} onDismiss={() => setInfo(null)} />
        </View>
      ) : null}
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} onDismiss={() => setError(null)} />
        </View>
      ) : null}

      {s.status === 'scheduled' ? (
        <>
          <SectionLabel>How will you take attendance?</SectionLabel>
          <Chips
            value={m}
            options={[
              { value: 'qr', label: 'QR — students scan' },
              { value: 'manual', label: 'Register — I tick names' },
            ]}
            onChange={setMode}
          />
          {m === 'qr' ? (
            <Card style={{ marginTop: 12 }}>
              <Field label="Classroom location" hint="Students must be inside this circle when they scan.">
                <Chips
                  value={roomHasLocation ? w : 'phone'}
                  options={roomHasLocation ? [{ value: 'phone', label: 'This phone, now' }, { value: 'room', label: 'Room’s saved spot' }] : [{ value: 'phone', label: 'This phone, now' }]}
                  onChange={setWhere}
                />
              </Field>
              <Field label="Allowed distance">
                <Chips value={r} options={RADII} onChange={setRadius} />
              </Field>
              <Field label="QR changes every" hint="Faster = harder to share a photo of the code.">
                <Chips value={rot} options={ROTATIONS} onChange={setRotation} />
              </Field>
            </Card>
          ) : (
            <Card tone="amber" style={{ marginTop: 12, flexDirection: 'row', gap: 12 }}>
              <ClipboardList color={colors.amber} size={20} />
              <Text variant="small" color={colors.text} style={{ flex: 1 }}>
                You’ll tick each student yourself. Every tick is saved under your name with the time — check names carefully.
              </Text>
            </Card>
          )}
          {!startable && startsIn > 0 ? (
            <Text variant="small" style={{ marginTop: 12 }}>
              Starts in {minutesLabel(startsIn)}. You can start up to 2 hours early.
            </Text>
          ) : null}
          <Button
            title={m === 'qr' ? 'Start class & show QR' : 'Open the register'}
            onPress={() => (m === 'qr' ? void start() : router.push({ pathname: '/register/[id]', params: { id: s.id } }))}
            loading={busy === 'start'}
            disabled={m === 'qr' ? !startable : !canEditRegister}
            icon={m === 'qr' ? <QrCode color="#0a0a0a" size={18} /> : <ClipboardList color="#0a0a0a" size={18} />}
            style={{ marginTop: 16 }}
          />
          {m === 'qr' ? (
            <View style={[styles.hintRow, { marginTop: 10 }]}>
              <MapPin color={colors.textDim} size={13} />
              <Text variant="small" style={{ flex: 1 }}>
                Works offline too: the code keeps rotating and students’ scans sync later.
              </Text>
            </View>
          ) : null}
          {canReorganise ? (
            <>
              <SectionLabel>Adjustment</SectionLabel>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button title="Move" kind="secondary" compact onPress={() => setAdjust('reschedule')} icon={<ArrowRightLeft color={colors.text} size={15} />} style={{ flex: 1 }} />
                {isAdmin ? <Button title="Give to a teacher" kind="secondary" compact onPress={() => setAdjust('substitute')} icon={<UserRound color={colors.text} size={15} />} style={{ flex: 1 }} /> : null}
              </View>
              <Button title="Cancel this class" kind="danger" onPress={() => setAdjust('cancel')} icon={<XCircle color={colors.red} size={16} />} style={{ marginTop: 10 }} />
              <Text variant="small" style={{ marginTop: 8 }}>
                Students of {s.courseCode} are notified immediately. Changes are checked for clashes with other classes, teachers and rooms.
                {isAdmin ? '' : ' Can’t take this class? Ask your admin (principal / HOD) — only they can give it to another teacher.'}
              </Text>
            </>
          ) : (
            <Text variant="small" style={{ marginTop: 18 }}>
              You’re taking this class as a substitute. Only its own teacher or an admin can move or cancel it.
            </Text>
          )}
          <AdjustSheet session={s} tz={tz} mode={adjust === 'substitute' ? null : adjust} onClose={() => setAdjust(null)} />
          {adjust === 'substitute' ? <CoverSheet session={s} teacherId={null} tz={tz} meId={me.data?.user.id} onClose={() => setAdjust(null)} /> : null}
        </>
      ) : null}

      {s.status === 'live' ? (
        <View style={{ gap: 10, marginTop: 18 }}>
          {s.mode === 'qr' ? (
            <>
              <Button title="Show the QR code" onPress={() => router.push({ pathname: '/live/[id]', params: { id: s.id } })} icon={<QrCode color="#0a0a0a" size={18} />} />
              <Button title="Show on a big screen" kind="secondary" onPress={() => setBigScreen(true)} icon={<Monitor color={colors.text} size={16} />} />
              <BigScreenSheet sessionId={s.id} courseLabel={s.courseCode} open={bigScreen} onClose={() => setBigScreen(false)} />
            </>
          ) : null}
          <Button title={s.mode === 'qr' ? 'Mark someone by hand' : 'Open the register'} kind="secondary" onPress={() => router.push({ pathname: '/register/[id]', params: { id: s.id } })} icon={<ClipboardList color={colors.text} size={16} />} />
          <Button title="End class" kind="danger" onPress={end} loading={busy === 'end'} />
        </View>
      ) : null}

      {s.status === 'closed' ? (
        <View style={{ gap: 10, marginTop: 18 }}>
          <Card>
            <InfoRow label="STARTED" value={s.startedAt ? clock(s.startedAt, tz) : '—'} />
            <InfoRow label="ENDED" value={s.endedAt ? clock(s.endedAt, tz) : '—'} />
            <InfoRow label="PRESENT" value={`${s.marked} of ${s.enrolled}`} />
          </Card>
          {canEditRegister ? (
            <Button title="Correct the register" kind="secondary" onPress={() => router.push({ pathname: '/register/[id]', params: { id: s.id } })} icon={<ClipboardList color={colors.text} size={16} />} />
          ) : (
            <Text variant="small">Registers older than 14 days can only be changed by an admin.</Text>
          )}
        </View>
      ) : null}

      {s.status === 'cancelled' ? (
        <Card style={{ marginTop: 18 }}>
          <Text variant="small">This class was cancelled. It doesn’t count towards anyone’s attendance.</Text>
        </Card>
      ) : null}

      {s.status !== 'scheduled' && s.status !== 'cancelled' ? (
        <>
          {flags.length ? (
            <>
              <SectionLabel>{`Suspicious scans · ${flags.length}`}</SectionLabel>
              <Card tone="amber" style={{ gap: 8 }}>
                {flags.slice(0, 5).map((f) => (
                  <View key={f.id} style={styles.hintRow}>
                    <ShieldAlert color={colors.amber} size={14} />
                    <Text variant="small" color={colors.text} style={{ flex: 1 }}>
                      {f.fullName ?? 'Unknown'} · {f.code} · {timeAgo(f.at)}
                    </Text>
                  </View>
                ))}
                <Button title="Review flags" kind="secondary" compact onPress={() => router.push('/flags')} />
              </Card>
            </>
          ) : null}
          <SectionLabel right={<Text variant="monoSmall">{(feed.isError || feed.fetchStatus === 'paused') && !feed.data ? 'offline' : `${present.length} / ${entries.length}`}</Text>}>Present</SectionLabel>
          {(feed.isError || feed.fetchStatus === 'paused') && !feed.data ? (
            <Card style={styles.hintRow}>
              <CloudOff color={colors.textDim} size={16} />
              <Text variant="small" style={{ flex: 1 }}>
                The live list needs internet. Scans made now are kept by students’ phones and arrive when they’re online.
              </Text>
            </Card>
          ) : (
            <Card padded={false}>
              {present.length === 0 ? (
                <Text variant="small" style={{ padding: 16 }}>
                  No one marked yet.
                </Text>
              ) : (
                present.map((e, i) => <EntryRow key={e.userId} e={e} tz={tz} first={i === 0} />)
              )}
            </Card>
          )}
          {absent.length ? (
            <>
              <SectionLabel right={<Text variant="monoSmall">{String(absent.length)}</Text>}>Not marked</SectionLabel>
              <Card padded={false}>
                {absent.map((e, i) => (
                  <EntryRow key={e.userId} e={e} tz={tz} first={i === 0} />
                ))}
              </Card>
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

function EntryRow({ e, tz, first }: { e: FeedEntry; tz?: string; first: boolean }) {
  const how = !e.present
    ? e.revokedReason ?? null
    : e.source === 'manual'
      ? `Register${e.markedBy ? ` · ${e.markedBy}` : ''}`
      : e.source === 'review'
        ? 'Approved after review'
        : `QR${e.offline ? ' · offline' : ''}${e.distanceM !== null ? ` · ${e.distanceM} m` : ''}`;
  return (
    <View style={[styles.entry, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}>
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {e.fullName}
        </Text>
        <Text variant="small" numberOfLines={1}>
          {[e.rollNo, how].filter(Boolean).join(' · ') || ' '}
        </Text>
      </View>
      {e.present ? <Text variant="monoSmall">{e.markedAt ? clock(e.markedAt, tz) : ''}</Text> : <Badge label="Absent" tone="muted" dot={false} />}
    </View>
  );
}

const styles = StyleSheet.create({
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 11 },
});
