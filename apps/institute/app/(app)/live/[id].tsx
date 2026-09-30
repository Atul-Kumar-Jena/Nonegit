import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardList, CloudOff, Monitor, Users, X } from 'lucide-react-native';
import { currentQrSeq, encodeQrToken, fromB64url, msUntilNextRotation, randomToken, type StaffSession } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, IconButton, Notice, Text } from '@kit/components/ui';
import { ApiRequestError } from '@kit/lib/api-core';
import { outbox } from '@kit/lib/outbox';
import { useApi } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { staffApi } from '@/api';
import { BigScreenSheet, useScreens } from '@/components/BigScreen';
import { confirmAction } from '@/components/forms';
import { QrCode } from '@/components/QrCode';
import { localSessions } from '@/local-sessions';
import { useFeed } from '@/queries';
import { useSessionView } from '@/session-view';

/**
 * The classroom screen: a QR code that changes every few seconds. It is computed
 * on this phone from the class key and the server-synced clock, so it keeps
 * working with no internet. The screen stays on (screenshots can be blocked in More → This phone).
 */
/** Keeps the screen on while the QR is showing (best effort: never crashes if the platform refuses). */
function useScreenOn() {
  useEffect(() => {
    const tag = 'attendly-live-qr';
    activateKeepAwakeAsync(tag).catch(() => undefined);
    return () => {
      try {
        void Promise.resolve(deactivateKeepAwake(tag)).catch(() => undefined);
      } catch {
        /* not active yet */
      }
    };
  }, []);
}

export default function LiveQr() {
  useScreenOn();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = String(rawId ?? '');
  const api = useApi();
  const qc = useQueryClient();
  const { session: sv, secret } = useSessionView(id);
  const feed = useFeed(id, true);
  // The live feed carries the freshest state (e.g. the class closed itself when everyone was marked).
  const s = feed.data?.session && sv ? { ...sv, ...feed.data.session } : sv;
  const { width, height } = useWindowDimensions();
  const [now, setNow] = useState(() => api.serverNow());
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bigScreen, setBigScreen] = useState(false);
  const screens = useScreens(id, true);

  useEffect(() => {
    const t = setInterval(() => setNow(api.serverNow()), 250);
    return () => clearInterval(t);
  }, [api]);

  // Tell the server the QR is on screen (now and every 30 s): students see “attendance being taken”.
  const live = s?.status === 'live';
  useEffect(() => {
    if (!live) return;
    const ping = () => void staffApi.showing(api, id).catch(() => undefined);
    ping();
    const t = setInterval(ping, 30_000);
    return () => clearInterval(t);
  }, [api, id, live]);

  const key = useMemo(() => {
    try {
      return secret ? fromB64url(secret) : null;
    } catch {
      return null;
    }
  }, [secret]);
  const rotation = s?.rotationS ?? 7;
  const seq = currentQrSeq(now, rotation);
  const token = useMemo(() => (key && s ? encodeQrToken(key, s.id, seq) : null), [key, s, seq]);
  const left = msUntilNextRotation(now, rotation);
  const size = Math.min(width - 48, height * 0.52, 420);

  const close = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/session/[id]', params: { id } }));

  function end() {
    confirmAction('End this class?', 'The QR stops working for everyone.', 'End class', async () => {
      setEnding(true);
      const body = { clientRef: randomToken(12) };
      try {
        await staffApi.end(api, id, body);
      } catch (err) {
        if (err instanceof ApiRequestError && (err.code === 'NETWORK' || err.code === 'TIMEOUT' || err.status >= 500)) {
          const endedAt = api.serverNow();
          await outbox.enqueue('session.end', `${s?.courseCode ?? 'Class'} · class ended`, { sessionId: id, body: { ...body, endedAt } });
          await localSessions.patch(id, { status: 'closed', endedAt });
          if (!localSessions.get(id) && s)
            await localSessions.put({
              sessionId: id,
              status: 'closed',
              mode: s.mode,
              startedAt: s.startedAt ? Date.parse(s.startedAt) : endedAt,
              endedAt,
              rotationS: s.rotationS,
              secret: null,
              courseCode: s.courseCode,
              courseTitle: s.courseTitle,
            });
        } else {
          setError(err instanceof Error ? err.message : 'Couldn’t end the class.');
          setEnding(false);
          return;
        }
      }
      void qc.invalidateQueries({ queryKey: ['staff'] });
      setEnding(false);
      close();
    });
  }

  const marked = feed.data?.session.marked ?? s?.marked ?? 0;
  const enrolled = feed.data?.session.enrolled ?? s?.enrolled ?? 0;
  const offlineNow = feed.isError || feed.fetchStatus === 'paused';

  return (
    <Screen scroll={false} edges={['top', 'bottom']} contentStyle={{ alignItems: 'center' }}>
      <View style={styles.top}>
        <IconButton label="Close" onPress={close}>
          <X color={colors.text} size={18} />
        </IconButton>
        <View style={{ flex: 1 }}>
          <Text variant="label" numberOfLines={1}>
            {s ? `${s.courseCode}${s.lectureNo ? ` · Lecture ${s.lectureNo}` : ''}` : 'Class'}
          </Text>
          <Text variant="heading" numberOfLines={1}>
            {s?.courseTitle ?? ''}
          </Text>
        </View>
        {offlineNow ? <Badge label="Offline" tone="amber" icon={<CloudOff color={colors.amber} size={11} />} /> : <Badge label="LIVE" tone="cyan" />}
      </View>

      {!s || s.status !== 'live' ? (
        <View style={styles.center}>
          <Notice
            tone={s?.autoEnded ? 'green' : 'amber'}
            message={
              s?.autoEnded
                ? `Everyone is marked (${s.marked} of ${s.enrolled}) — the class closed itself and the QR stopped working.`
                : s?.status === 'closed'
                  ? 'This class has ended.'
                  : 'This class isn’t running. Start it from the class screen.'
            }
          />
          <Button title="Back" kind="secondary" onPress={close} style={{ marginTop: 16, alignSelf: 'stretch' }} />
        </View>
      ) : !token ? (
        <View style={styles.center}>
          <Notice tone="red" message="This phone doesn’t have this class’s QR key. Connect to the internet once, or use the register." />
          <Button title="Open the register" onPress={() => router.replace({ pathname: '/register/[id]', params: { id } })} style={{ marginTop: 16, alignSelf: 'stretch' }} />
        </View>
      ) : (
        <View style={styles.center}>
          <QrCode value={token} size={size} />
          <View style={[styles.progress, { width: size }]}>
            <View style={[styles.progressFill, { width: `${Math.max(0, Math.min(100, (left / (rotation * 1000)) * 100))}%` }]} />
          </View>
          <View style={styles.meta}>
            <Text variant="small">{`New code in ${Math.ceil(left / 1000)} s`}</Text>
          </View>
          <View style={styles.count}>
            <Users color={colors.green} size={18} />
            <Text style={styles.countText}>
              {marked}
              <Text variant="body"> / {enrolled} present</Text>
            </Text>
          </View>
          <Rounds session={s} onChange={() => void qc.invalidateQueries({ queryKey: ['staff'] })} />
          {offlineNow ? (
            <Text variant="small" style={{ textAlign: 'center', marginTop: 6 }}>
              No internet — the code still works. Students’ scans are saved on their phones and upload later.
            </Text>
          ) : null}
        </View>
      )}

      {error ? <Notice tone="red" message={error} onDismiss={() => setError(null)} /> : null}
      <Button
        title={screens.data?.length ? `Big screen · ${screens.data.length} connected` : 'Show on a big screen'}
        kind="secondary"
        onPress={() => setBigScreen(true)}
        disabled={!s || s.status !== 'live'}
        icon={<Monitor color={colors.text} size={16} />}
        style={{ alignSelf: 'stretch', marginTop: 12 }}
      />
      <View style={styles.actions}>
        <Button title="Register" kind="secondary" onPress={() => router.push({ pathname: '/register/[id]', params: { id } })} icon={<ClipboardList color={colors.text} size={16} />} style={{ flex: 1 }} />
        <Button title="End class" kind="danger" onPress={end} loading={ending} disabled={!s || s.status !== 'live'} style={{ flex: 1 }} />
      </View>
      {s ? <BigScreenSheet sessionId={id} courseLabel={s.courseCode} open={bigScreen} onClose={() => setBigScreen(false)} /> : null}
    </Screen>
  );
}

/**
 * Layered scans (fests, webinars): students must scan in every round to be present, so nobody
 * leaves after the first scan. Set the number before anyone completes; open each next round when you want.
 */
function Rounds({ session: s, onChange }: { session: StaffSession; onChange: () => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rounds = s.scanRounds ?? 1;
  const roundNo = s.roundNo ?? 1;
  const canSet = s.marked === 0 && roundNo === 1;
  async function run(fn: () => Promise<unknown>) {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t work.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={styles.rounds}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Text variant="small">Scans per student</Text>
        {[1, 2, 3].map((n) => (
          <Pressable
            key={n}
            disabled={!canSet || busy || n === rounds}
            onPress={() => void run(() => staffApi.scanRounds(api, s.id, n))}
            style={[styles.roundChip, n === rounds && styles.roundChipOn, !canSet && n !== rounds && { opacity: 0.35 }]}
            accessibilityRole="button"
            accessibilityState={{ selected: n === rounds }}
          >
            <Text variant="small" color={n === rounds ? colors.bg : colors.text}>
              {n === 1 ? 'Once' : `${n}×`}
            </Text>
          </Pressable>
        ))}
      </View>
      {rounds > 1 ? (
        <>
          <Text variant="small" style={{ textAlign: 'center' }}>
            {`Round ${roundNo} of ${rounds} open · scanned: ${(s.roundCounts ?? []).slice(0, roundNo).map((c, i) => `R${i + 1} ${c}`).join(' · ')}`}
          </Text>
          {roundNo < rounds ? (
            <Button title={`Open round ${roundNo + 1}`} kind="secondary" compact loading={busy} onPress={() => void run(() => staffApi.nextRound(api, s.id))} />
          ) : (
            <Text variant="small" style={{ textAlign: 'center' }}>
              Last round open — students who scanned every round are present.
            </Text>
          )}
        </>
      ) : null}
      {err ? <Text variant="small" color={colors.red} style={{ textAlign: 'center' }}>{err}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rounds: { alignItems: 'center', gap: 8, marginTop: 12, alignSelf: 'stretch' },
  roundChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  roundChipOn: { backgroundColor: colors.text, borderColor: colors.text },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  progress: { height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: 14, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: colors.cyan },
  meta: { flexDirection: 'row', alignItems: 'baseline', gap: 12, marginTop: 10 },
  count: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18 },
  countText: { fontFamily: fonts.display, fontSize: 26, color: colors.text },
  actions: { flexDirection: 'row', gap: 10, alignSelf: 'stretch', marginTop: 10 },
});
