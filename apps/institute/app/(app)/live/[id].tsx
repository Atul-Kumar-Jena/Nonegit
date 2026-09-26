import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardList, CloudOff, Monitor, Users, X } from 'lucide-react-native';
import { currentQrSeq, encodeQrToken, fromB64url, msUntilNextRotation, randomToken, seqLabel } from '@attendly/protocol';
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
 * working with no internet. Screenshots are blocked; the screen stays on.
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
  const { session: s, secret } = useSessionView(id);
  const feed = useFeed(id, true);
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
          <Notice tone="amber" message={s?.status === 'closed' ? 'This class has ended.' : 'This class isn’t running. Start it from the class screen.'} />
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
            <Text style={styles.seq}>{seqLabel(seq)}</Text>
            <Text variant="monoSmall">changes in {Math.ceil(left / 1000)} s</Text>
          </View>
          <View style={styles.count}>
            <Users color={colors.green} size={18} />
            <Text style={styles.countText}>
              {marked}
              <Text variant="body"> / {enrolled} present</Text>
            </Text>
          </View>
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

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  progress: { height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: 14, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: colors.cyan },
  meta: { flexDirection: 'row', alignItems: 'baseline', gap: 12, marginTop: 10 },
  seq: { fontFamily: fonts.monoMedium, fontSize: 18, color: colors.text },
  count: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18 },
  countText: { fontFamily: fonts.bold, fontSize: 26, color: colors.text },
  actions: { flexDirection: 'row', gap: 10, alignSelf: 'stretch', marginTop: 10 },
});
