import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Linking, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Camera, MapPin } from 'lucide-react-native';
import { GOOD_FIX_M, fuseSamples, parseQrToken, samplesForScan, type MarkBody } from '@attendly/protocol';
import { Button, Card, IconButton, IconTile, Text } from '@kit/components/ui';
import { ApiRequestError, verifyReceipt } from '@kit/lib/api-core';
import { confirmWithBiometrics } from '@kit/lib/biometrics';
import { LocationError, getFreshFix, startLocationStream, toWireSamples, type LocationStream } from '@kit/lib/location';
import { loadPrefs } from '@kit/lib/prefs';
import { outbox } from '@kit/lib/outbox';
import { pinnedKey } from '@kit/lib/server-config';
import { QrScanner } from '@/components/QrScanner';
import { studentQueryKeys } from '@/state/queries';
import { setScanOutcome } from '@/state/scan-result';
import { useApi, useSession } from '@kit/state/session';
import { colors, radius } from '@kit/theme';

/** Fixes already this good at the moment of scanning are used at once, without waiting. */
const READY_FIX_M = 20;

type Stage = 'scanning' | 'locating' | 'confirming' | 'submitting';

/** 05 · Scanner — rotating QR + geofence. */
export default function Scan() {
  const { course } = useLocalSearchParams<{ course?: string }>();
  const api = useApi();
  const { server } = useSession();
  const qc = useQueryClient();
  const [permission, requestPermission] = useCameraPermissions();
  const [stage, setStage] = useState<Stage>('scanning');
  const [hint, setHint] = useState<string | null>(null);
  const [locProblem, setLocProblem] = useState<LocationError | null>(null);
  const busy = useRef(false);
  const gps = useRef<LocationStream | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const line = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(line, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(line, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [line]);

  // GPS streams while the scanner is open, so the fixes of the last seconds are ready at scan time.
  const warmUp = useCallback(() => {
    setLocProblem(null);
    gps.current?.stop();
    gps.current = null;
    startLocationStream()
      .then((stream) => {
        gps.current = stream;
      })
      .catch((err) => {
        if (err instanceof LocationError && (err.problem === 'permission-denied' || err.problem === 'services-off')) setLocProblem(err);
      });
  }, []);

  useEffect(() => {
    warmUp();
    return () => {
      gps.current?.stop();
      gps.current = null;
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, [warmUp]);

  /** The scan's location: the fixes of the last seconds (waiting briefly only if none is good yet). */
  async function locate(scannedAt: number): Promise<MarkBody['location']> {
    const offset = api.serverNow() - Date.now();
    const stream = gps.current;
    let fixes = stream ? samplesForScan(toWireSamples(stream.samples(), offset), scannedAt) : [];
    const ready = fixes.length >= 2 && Math.min(...fixes.map((f) => f.accuracyM)) <= READY_FIX_M;
    if (!ready) {
      setStage('locating');
      if (stream) {
        await stream.settle({ minSamples: 3, goodM: GOOD_FIX_M, maxWaitMs: 5_000, timeoutMs: 15_000 });
        fixes = samplesForScan(toWireSamples(stream.samples(), offset), Math.round(api.serverNow()));
      } else fixes = toWireSamples([await getFreshFix(15_000)], offset);
    }
    const fused = fuseSamples(fixes);
    const best = fused ?? fixes[fixes.length - 1]!;
    return {
      lat: best.lat,
      lng: best.lng,
      accuracyM: Math.max(0, best.accuracyM),
      mocked: fixes.some((f) => f.mocked),
      capturedAt: fused ? fused.t : fixes[fixes.length - 1]!.t,
      samples: fixes,
    };
  }

  function flash(msg: string) {
    setHint(msg);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 2200);
  }

  const onScanned = useCallback(
    async (data: string) => {
      if (busy.current) return;
      // Foreign QR codes are filtered by the scanner; checked again here as defence in depth.
      if (!parseQrToken(data)) return;
      busy.current = true;
      setStage('locating');
      // The moment of scanning on the server's clock — what an offline upload is judged against.
      const scannedAt = Math.round(api.serverNow());
      let body: MarkBody | null = null;
      try {
        if ((await loadPrefs()).biometricForScans) {
          setStage('confirming');
          if (!(await confirmWithBiometrics('Confirm it’s you to mark attendance'))) {
            busy.current = false;
            setStage('scanning');
            flash('Biometric check cancelled.');
            return;
          }
        }
        const location = await locate(scannedAt);
        setStage('submitting');
        body = { qr: data, location };
        const res = await api.mark(body);
        const receiptVerified = server ? verifyReceipt(res, pinnedKey(server)) : false;
        setScanOutcome({ kind: 'success', res, receiptVerified });
        void Haptics.notificationAsync(receiptVerified ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
        for (const queryKey of studentQueryKeys) void qc.invalidateQueries({ queryKey });
      } catch (err) {
        const notStarted = err instanceof ApiRequestError && err.rejection?.code === 'E-NOT-STARTED';
        if (body && err instanceof ApiRequestError && (notStarted || err.code === 'NETWORK' || err.code === 'TIMEOUT' || err.status >= 500)) {
          // No internet (or the server is down): keep the signed-off scan encrypted on the phone
          // and upload it automatically. The server re-checks everything against the scan time.
          const label = `${course ? course.split(' · ')[0] : 'Class'} scan · ${new Date(scannedAt).toTimeString().slice(0, 5)}`;
          try {
            await outbox.enqueue('mark', label, { ...body, scannedAt });
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
            setScanOutcome({ kind: 'queued', label, reason: notStarted ? 'not-started' : 'offline' });
            router.replace('/result');
            return;
          } catch {
            // fall through to the plain error below
          }
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
        if (err instanceof ApiRequestError && err.rejection) setScanOutcome({ kind: 'rejected', rejection: err.rejection });
        else if (err instanceof LocationError) setScanOutcome({ kind: 'error', title: 'Location needed', message: err.message });
        else if (err instanceof ApiRequestError && err.transient)
          setScanOutcome({ kind: 'error', title: 'No connection', message: `${err.message} Your mark could not be saved — scan the live code again.` });
        else setScanOutcome({ kind: 'error', title: 'Couldn’t mark attendance', message: err instanceof Error ? err.message : 'Unexpected error.' });
      }
      router.replace('/result');
    },
    [api, qc, server],
  );

  const granted = permission?.granted === true;
  const translateY = line.interpolate({ inputRange: [0, 1], outputRange: [0, 230] });

  return (
    <View style={styles.root}>
      {granted ? <QrScanner active={stage === 'scanning'} onCode={(d) => void onScanned(d)} onForeign={() => flash('That’s not an Attendly session code.')} /> : null}
      <View style={[StyleSheet.absoluteFill, styles.dim]} pointerEvents="none" />

      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']} pointerEvents="box-none">
        <View style={styles.header}>
          <IconButton label="Close scanner" onPress={() => router.back()} style={styles.headerBtn}>
            <ArrowLeft color={colors.text} size={18} />
          </IconButton>
          <View style={{ flex: 1 }}>
            {course ? (
              <Text variant="label" numberOfLines={1} color={colors.textMuted}>
                {course}
              </Text>
            ) : null}
            <Text variant="heading">Scan session QR</Text>
          </View>
        </View>

        <View style={styles.center} pointerEvents="box-none">
          {permission && !granted ? (
            <Card style={styles.panel}>
              <IconTile tone="cyan" size={48}>
                <Camera color={colors.cyan} size={22} />
              </IconTile>
              <Text variant="heading" style={{ marginTop: 12 }}>
                Camera access needed
              </Text>
              <Text variant="small" style={{ textAlign: 'center', marginTop: 6 }}>
                Attendly uses the camera only to read your class’s rotating QR code. Nothing is recorded or uploaded.
              </Text>
              {permission.canAskAgain ? (
                <Button title="Allow camera" onPress={() => void requestPermission()} style={{ alignSelf: 'stretch', marginTop: 16 }} />
              ) : (
                <Button title="Open Settings" onPress={() => void Linking.openSettings()} style={{ alignSelf: 'stretch', marginTop: 16 }} />
              )}
            </Card>
          ) : (
            <View style={styles.frame} accessibilityElementsHidden pointerEvents="none">
              <View style={[styles.corner, styles.tl]} />
              <View style={[styles.corner, styles.tr]} />
              <View style={[styles.corner, styles.bl]} />
              <View style={[styles.corner, styles.br]} />
              {stage === 'scanning' && granted ? <Animated.View style={[styles.line, { transform: [{ translateY }] }]} /> : null}
              {stage !== 'scanning' ? (
                <View style={styles.working}>
                  <ActivityIndicator color={colors.cyan} />
                  <Text variant="bodyStrong" style={{ marginTop: 10 }}>
                    {stage === 'locating' ? 'Getting a precise fix…' : stage === 'confirming' ? 'Confirm it’s you…' : 'Verifying & signing…'}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
        </View>

        <View style={styles.bottom}>
          {hint ? (
            <View style={styles.hint}>
              <Text variant="small" color={colors.amber}>
                {hint}
              </Text>
            </View>
          ) : null}
          {locProblem ? (
            <Card tone="amber" style={styles.locCard}>
              <MapPin color={colors.amber} size={18} />
              <View style={{ flex: 1 }}>
                <Text variant="small" color={colors.text}>
                  {locProblem.message}
                </Text>
              </View>
              <Button
                title={locProblem.problem === 'permission-denied' ? 'Settings' : 'Retry'}
                kind="secondary"
                compact
                onPress={() => (locProblem.problem === 'permission-denied' ? void Linking.openSettings() : warmUp())}
              />
            </Card>
          ) : (
            <Text variant="small" style={{ textAlign: 'center' }}>
              Point at the class QR — it’s picked up anywhere on screen. Tap to focus, pinch or 2×/4× to zoom on a far screen.
            </Text>
          )}
        </View>
      </SafeAreaView>
    </View>
  );
}

const FRAME = 250;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.black },
  dim: { backgroundColor: 'rgba(3,6,16,0.35)' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 8 },
  headerBtn: { backgroundColor: 'rgba(11,17,34,0.85)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  frame: { width: FRAME, height: FRAME },
  corner: { position: 'absolute', width: 36, height: 36, borderColor: colors.cyan },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: radius.md },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: radius.md },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: radius.md },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: radius.md },
  line: { position: 'absolute', left: 14, right: 14, top: 10, height: 2, borderRadius: 1, backgroundColor: colors.cyan, shadowColor: colors.cyan, shadowOpacity: 0.9, shadowRadius: 8 },
  working: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(5,8,20,0.75)', borderRadius: radius.lg },
  panel: { alignItems: 'center', padding: 22, alignSelf: 'stretch' },
  bottom: { paddingHorizontal: 20, paddingBottom: 12, gap: 10 },
  hint: { alignSelf: 'center', backgroundColor: 'rgba(251,191,36,0.12)', borderColor: 'rgba(251,191,36,0.35)', borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  locCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
});
