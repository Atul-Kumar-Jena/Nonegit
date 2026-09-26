import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { Redirect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { LogoMark } from '@/components/Logo';
import { Text } from '@/components/ui';
import { APP_VERSION } from '@/lib/env';
import { useSession } from '@/state/session';
import { colors, fonts } from '@/theme';

const MIN_SPLASH_MS = 900;

/** 01 · Splash — boot, load the device identity, then route. */
export default function Splash() {
  const { phase } = useSession();
  const [minElapsed, setMinElapsed] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), MIN_SPLASH_MS);
    const loop = Animated.loop(Animated.timing(progress, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => {
      clearTimeout(t);
      loop.stop();
    };
  }, [progress]);

  if (minElapsed && phase !== 'booting') {
    if (phase === 'signed-in') return <Redirect href="/home" />;
    if (phase === 'signed-out') return <Redirect href="/login" />;
    if (phase === 'identity-error') return <Redirect href="/identity" />;
    return <Redirect href="/server" />;
  }

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-40, 76] });
  return (
    <View style={styles.root}>
      <LinearGradient colors={['rgba(34,211,238,0.16)', 'rgba(5,8,20,0)']} start={{ x: 0.5, y: 0.2 }} end={{ x: 0.5, y: 0.6 }} style={StyleSheet.absoluteFill} />
      <LinearGradient colors={['rgba(5,8,20,0)', 'rgba(139,92,246,0.12)']} start={{ x: 0.5, y: 0.6 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={styles.center}>
        <View style={{ alignItems: 'center' }}>
          <LogoMark size={72} />
        </View>
        <Text style={styles.brand}>Attendly</Text>
        <Text variant="body" style={{ letterSpacing: 0.3 }}>
          Attendance, unforgeable.
        </Text>
        <View style={styles.track} accessibilityLabel="Loading">
          <Animated.View style={[styles.bar, { transform: [{ translateX }] }]} />
        </View>
      </View>
      <Text variant="label" style={styles.footer}>
        v{APP_VERSION} · secure boot · device-bound
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  brand: { fontFamily: fonts.bold, fontSize: 34, letterSpacing: -1, color: colors.text, marginTop: 14 },
  track: { width: 76, height: 3, borderRadius: 2, backgroundColor: 'rgba(138,148,173,0.18)', overflow: 'hidden', marginTop: 14 },
  bar: { width: 36, height: 3, borderRadius: 2, backgroundColor: colors.cyan },
  footer: { textAlign: 'center', marginBottom: 36 },
});
