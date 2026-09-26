import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, PanResponder, Platform, Pressable, StyleSheet, View, type LayoutRectangle } from 'react-native';
import { CameraView, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Flashlight, FlashlightOff } from 'lucide-react-native';
import { parseQrToken } from '@attendly/protocol';
import { Text } from '@kit/components/ui';
import { colors, fonts } from '@kit/theme';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ZOOMS = [
  { label: '1×', value: 0 },
  { label: '2×', value: 0.25 },
  { label: '4×', value: 0.5 },
] as const;

/** iOS: while nothing is found, re-trigger autofocus this often (Android focuses continuously on its own). */
const REFOCUS_EVERY_MS = 3_500;

/** Where the code is on screen, from the scanner's corner points (or bounds), in view coordinates. */
function rectOf(r: BarcodeScanningResult, view: LayoutRectangle | null): Rect | null {
  let x0: number, y0: number, x1: number, y1: number;
  const pts = r.cornerPoints ?? [];
  if (pts.length >= 3) {
    x0 = Math.min(...pts.map((p) => p.x));
    y0 = Math.min(...pts.map((p) => p.y));
    x1 = Math.max(...pts.map((p) => p.x));
    y1 = Math.max(...pts.map((p) => p.y));
  } else if (r.bounds && r.bounds.size.width > 0 && r.bounds.size.height > 0) {
    x0 = r.bounds.origin.x;
    y0 = r.bounds.origin.y;
    x1 = x0 + r.bounds.size.width;
    y1 = y0 + r.bounds.size.height;
  } else return null;
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const pad = 14;
  const W = view?.width ?? Number.POSITIVE_INFINITY;
  const H = view?.height ?? Number.POSITIVE_INFINITY;
  const x = Math.max(0, x0 - pad);
  const y = Math.max(0, y0 - pad);
  const w = Math.min(W - x, x1 - x0 + pad * 2);
  const h = Math.min(H - y, y1 - y0 + pad * 2);
  return w > 8 && h > 8 ? { x, y, w, h } : null;
}

/**
 * Telegram-style QR scanner: finds the code anywhere in the camera view (not just
 * inside a box), snaps a highlight onto it and captures it immediately. Keeps
 * refocusing, tap to focus, pinch or 1×/2×/4× to zoom on a far-away projector,
 * torch for dark rooms. Only Attendly session codes are ever handed on.
 */
export function QrScanner({ active, onCode, onForeign }: { active: boolean; onCode: (data: string) => void; onForeign: () => void }) {
  const [layout, setLayout] = useState<LayoutRectangle | null>(null);
  const [lock, setLock] = useState<{ rect: Rect | null; ok: boolean } | null>(null);
  const [zoom, setZoom] = useState(0);
  const [torch, setTorch] = useState(false);
  const [autofocus, setAutofocus] = useState<'on' | 'off'>('off');
  const [focusAt, setFocusAt] = useState<{ x: number; y: number } | null>(null);
  const lockAnim = useRef(new Animated.Value(0)).current;
  const focusAnim = useRef(new Animated.Value(0)).current;
  const lastForeign = useRef(0);
  const lastSeen = useRef(0);
  const clearLock = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomRef = useRef(0);
  zoomRef.current = zoom;

  // Back to scanning → drop the old lock.
  useEffect(() => {
    if (active) setLock(null);
  }, [active]);

  const refocus = useCallback(() => {
    // "on" = focus once now; then back to continuous.
    setAutofocus('on');
    setTimeout(() => setAutofocus('off'), 600);
  }, []);

  useEffect(() => {
    if (!active || Platform.OS !== 'ios') return;
    const t = setInterval(() => {
      if (Date.now() - lastSeen.current > REFOCUS_EVERY_MS) refocus();
    }, REFOCUS_EVERY_MS);
    return () => clearInterval(t);
  }, [active, refocus]);

  useEffect(
    () => () => {
      if (clearLock.current) clearTimeout(clearLock.current);
    },
    [],
  );

  const showLock = useCallback(
    (rect: Rect | null, ok: boolean) => {
      setLock({ rect, ok });
      lockAnim.setValue(0);
      Animated.timing(lockAnim, { toValue: 1, duration: 180, easing: Easing.out(Easing.back(1.6)), useNativeDriver: true }).start();
      if (clearLock.current) clearTimeout(clearLock.current);
      if (!ok) clearLock.current = setTimeout(() => setLock(null), 900);
    },
    [lockAnim],
  );

  const onScanned = useCallback(
    (r: BarcodeScanningResult) => {
      lastSeen.current = Date.now();
      const rect = rectOf(r, layout);
      if (parseQrToken(r.data)) {
        showLock(rect, true);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
        onCode(r.data);
        return;
      }
      // Someone else's QR (a poster, a Wi-Fi code…): mark it briefly, never submit it.
      if (Date.now() - lastForeign.current > 2_200) {
        lastForeign.current = Date.now();
        showLock(rect, false);
        onForeign();
      }
    },
    [layout, onCode, onForeign, showLock],
  );

  // Tap to focus, pinch to zoom.
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (e) => e.nativeEvent.touches.length === 2,
        onPanResponderGrant: () => {
          pinch.current = null;
        },
        onPanResponderMove: (e) => {
          const t = e.nativeEvent.touches;
          if (t.length !== 2 || !t[0] || !t[1]) return;
          const dist = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
          if (!pinch.current) pinch.current = { dist, zoom: zoomRef.current };
          const next = Math.min(1, Math.max(0, pinch.current.zoom + (dist - pinch.current.dist) / 600));
          setZoom(Math.round(next * 100) / 100);
        },
        onPanResponderRelease: (e, g) => {
          if (pinch.current || Math.abs(g.dx) > 10 || Math.abs(g.dy) > 10) return;
          setFocusAt({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
          focusAnim.setValue(0);
          Animated.timing(focusAnim, { toValue: 1, duration: 700, useNativeDriver: true }).start(() => setFocusAt(null));
          refocus();
        },
      }),
    [focusAnim, refocus],
  );

  return (
    <View style={StyleSheet.absoluteFill} onLayout={(e) => setLayout(e.nativeEvent.layout)}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        zoom={zoom}
        enableTorch={torch}
        autofocus={autofocus}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={active ? onScanned : undefined}
        accessibilityLabel="Camera viewfinder"
      />
      <View style={StyleSheet.absoluteFill} {...responder.panHandlers} />

      {lock?.rect ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.lock,
            {
              left: lock.rect.x,
              top: lock.rect.y,
              width: lock.rect.w,
              height: lock.rect.h,
              borderColor: lock.ok ? colors.cyan : colors.amber,
              opacity: lockAnim,
              transform: [{ scale: lockAnim.interpolate({ inputRange: [0, 1], outputRange: [1.25, 1] }) }],
            },
          ]}
        />
      ) : null}

      {focusAt ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.focus,
            {
              left: focusAt.x - 36,
              top: focusAt.y - 36,
              opacity: focusAnim.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] }),
              transform: [{ scale: focusAnim.interpolate({ inputRange: [0, 0.3, 1], outputRange: [1.4, 1, 1] }) }],
            },
          ]}
        />
      ) : null}

      <View style={styles.controls} pointerEvents="box-none">
        <View style={styles.zooms}>
          {ZOOMS.map((z) => {
            const on = Math.abs(zoom - z.value) < 0.05;
            return (
              <Pressable key={z.label} onPress={() => setZoom(z.value)} accessibilityRole="button" accessibilityLabel={`Zoom ${z.label}`} style={[styles.zoom, on && styles.zoomOn]} hitSlop={6}>
                <Text style={[styles.zoomText, on && { color: colors.cyan }]}>{z.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Pressable onPress={() => setTorch((t) => !t)} accessibilityRole="switch" accessibilityState={{ checked: torch }} accessibilityLabel="Torch" style={[styles.zoom, torch && styles.zoomOn]} hitSlop={6}>
          {torch ? <Flashlight color={colors.cyan} size={16} /> : <FlashlightOff color={colors.text} size={16} />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lock: { position: 'absolute', borderWidth: 3, borderRadius: 14, shadowColor: colors.cyan, shadowOpacity: 0.9, shadowRadius: 12 },
  focus: { position: 'absolute', width: 72, height: 72, borderRadius: 36, borderWidth: 2, borderColor: '#ffffff' },
  controls: { position: 'absolute', left: 0, right: 0, bottom: 150, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 14 },
  zooms: { flexDirection: 'row', gap: 6, padding: 4, borderRadius: 999, backgroundColor: 'rgba(5,8,20,0.6)' },
  zoom: { minWidth: 40, height: 34, paddingHorizontal: 8, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(5,8,20,0.6)' },
  zoomOn: { backgroundColor: 'rgba(255, 255, 255, 0.18)' },
  zoomText: { fontFamily: fonts.monoMedium, fontSize: 13, color: colors.text },
});
