import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as ScreenCapture from 'expo-screen-capture';
import { Lock, ShieldAlert } from 'lucide-react-native';
import { LogoMark } from '@kit/components/Logo';
import { Backdrop } from '@kit/components/Screen';
import { Button, Text } from '@kit/components/ui';
import { useSession } from '@kit/state/session';
import { colors } from '@kit/theme';

/** How long the app may sit in the background before it asks again. */
const RELOCK_AFTER_MS = 30_000;

type LockState = 'checking' | 'locked' | 'no-screen-lock' | 'open';

/**
 * Staff phones hold student data and live QR secrets, so the Institute app:
 *  • refuses to run on a phone without a screen lock,
 *  • asks for fingerprint / face / device PIN on launch and after 30 s away,
 *  • hides its content in the app switcher and blocks screenshots/recording.
 */
export function AppLock({ children }: { children: ReactNode }) {
  const { phase, signOut } = useSession();
  const web = Platform.OS === 'web';
  const [state, setState] = useState<LockState>(web ? 'open' : 'checking');
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backgroundedAt = useRef<number | null>(null);
  const prompting = useRef(false);
  /** Signed in during this run (just typed the code): no second prompt, but the screen-lock rule still applies. */
  const freshLogin = useRef(false);
  if (phase === 'signed-out' || phase === 'needs-server') freshLogin.current = true;

  useEffect(() => {
    if (web) return;
    void ScreenCapture.preventScreenCaptureAsync('institute').catch(() => undefined);
    void ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => undefined);
    return () => void ScreenCapture.allowScreenCaptureAsync('institute').catch(() => undefined);
  }, [web]);

  const unlock = useCallback(async () => {
    if (web || prompting.current) return;
    prompting.current = true;
    setError(null);
    try {
      const level = await LocalAuthentication.getEnrolledLevelAsync().catch(() => LocalAuthentication.SecurityLevel.NONE);
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        setState('no-screen-lock');
        return;
      }
      if (freshLogin.current) {
        freshLogin.current = false;
        setState('open');
        return;
      }
      setState('locked');
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Attendly Institute', cancelLabel: 'Cancel', disableDeviceFallback: false });
      if (r.success) setState('open');
      else if (r.error !== 'user_cancel' && r.error !== 'system_cancel' && r.error !== 'app_cancel') setError('Couldn’t confirm it’s you. Try again.');
    } catch {
      setError('Couldn’t start the unlock prompt. Try again.');
    } finally {
      prompting.current = false;
    }
  }, [web]);

  // Lock on launch (once signed in); start over after a sign-out.
  useEffect(() => {
    if (web) return;
    if (phase !== 'signed-in') {
      if (phase !== 'booting' && state !== 'checking') setState('checking');
      return;
    }
    if (state === 'checking') void unlock();
  }, [phase, state, unlock, web]);

  useEffect(() => {
    if (web) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        setHidden(false);
        const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
        backgroundedAt.current = null;
        if (phase === 'signed-in' && (state === 'locked' || away > RELOCK_AFTER_MS)) {
          setState('locked');
          void unlock();
        }
      } else {
        setHidden(true);
        if (s === 'background' && !prompting.current) backgroundedAt.current ??= Date.now();
      }
    });
    return () => sub.remove();
  }, [phase, state, unlock, web]);

  // Signed-out screens (login, bind) don't hold staff data: no lock needed there.
  if (web || phase !== 'signed-in') return <>{children}</>;

  if (state === 'open')
    return (
      <View style={{ flex: 1 }}>
        {children}
        {hidden ? <View style={[StyleSheet.absoluteFill, styles.shield]} /> : null}
      </View>
    );

  return (
    <View style={styles.root}>
      <Backdrop />
      <View style={styles.center}>
        <LogoMark size={52} />
        {state === 'no-screen-lock' ? (
          <>
            <ShieldAlert color={colors.amber} size={28} style={{ marginTop: 28 }} />
            <Text variant="title" style={styles.text}>
              Set a screen lock first
            </Text>
            <Text variant="body" style={styles.text}>
              This phone has no PIN, pattern, password or fingerprint. Staff accounts can see student data, so Attendly Institute only runs on a locked phone. Add a screen lock in Settings → Security, then come back.
            </Text>
            <Button title="I’ve set it — check again" onPress={() => void unlock()} style={styles.btn} />
          </>
        ) : (
          <>
            <Lock color={colors.cyan} size={26} style={{ marginTop: 28 }} />
            <Text variant="title" style={styles.text}>
              Locked
            </Text>
            <Text variant="body" style={styles.text}>
              Confirm it’s you with your fingerprint, face or phone PIN.
            </Text>
            {error ? (
              <Text variant="small" color={colors.red} style={styles.text}>
                {error}
              </Text>
            ) : null}
            <Button title="Unlock" onPress={() => void unlock()} style={styles.btn} />
          </>
        )}
        <Button title="Sign out" kind="ghost" onPress={() => void signOut()} style={{ marginTop: 8, alignSelf: 'stretch' }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  text: { textAlign: 'center', marginTop: 10 },
  btn: { alignSelf: 'stretch', marginTop: 24 },
  shield: { backgroundColor: colors.bg },
});
