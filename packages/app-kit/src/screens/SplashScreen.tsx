import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { Redirect } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LogoMark } from '../components/Logo';
import { Text } from '../components/ui';
import { APP_VERSION } from '../lib/env';
import { useSession } from '../state/session';
import { colors, fonts } from '../theme';

const MIN_SPLASH_MS = 900;

/** 01 · Splash — boot, load the device identity, then route. */
export default function Splash() {
  const { phase } = useSession();
  const insets = useSafeAreaInsets();
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
    <View style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 28, paddingLeft: insets.left + 32, paddingRight: insets.right + 32 }]}>
      <LinearGradient colors={['rgba(255, 255, 255, 0.08)', 'rgba(255, 255, 255, 0)']} start={{ x: 0.5, y: 0.15 }} end={{ x: 0.5, y: 0.65 }} style={StyleSheet.absoluteFill} />
      <View style={styles.center}>
        <View style={{ alignItems: 'center' }}>
          <LogoMark size={72} />
        </View>
        <Text style={styles.brand}>Attendly</Text>
        <Text variant="body" style={styles.tagline}>
          Attendance, unforgeable.
        </Text>
        <View style={styles.track} accessibilityLabel="Loading">
          <Animated.View style={[styles.bar, { transform: [{ translateX }] }]} />
        </View>
      </View>
      <Text variant="small" style={styles.footer}>
        v{APP_VERSION}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  brand: { fontFamily: fonts.display, fontSize: 40, lineHeight: 48, letterSpacing: -1.5, color: colors.text, marginTop: 18 },
  tagline: { letterSpacing: 0.3, textAlign: 'center' },
  track: { width: 76, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden', marginTop: 22 },
  bar: { width: 36, height: 3, borderRadius: 2, backgroundColor: colors.cyan },
  footer: { textAlign: 'center', opacity: 0.6 },
});
