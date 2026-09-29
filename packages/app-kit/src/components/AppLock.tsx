import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { loadScreenshotSetting } from '../lib/screenshots';
import { loadPrefs } from '../lib/prefs';
import { Lock, ShieldAlert } from 'lucide-react-native';
import { LogoMark } from './Logo';
import { Backdrop } from './Screen';
import { Button, Text } from './ui';
import { useSession } from '../state/session';
import { colors } from '../theme';

/** How long the app may sit in the background before it asks again. */
const RELOCK_AFTER_MS = 30_000;

type LockState = 'checking' | 'locked' | 'no-screen-lock' | 'open';

/**
 * Staff and developer phones hold student data, live QR secrets or platform controls, so these apps:
 *  • refuses to run on a phone without a screen lock,
 *  • asks for fingerprint / face / device PIN on launch and after 30 s away,
 *  • can block screenshots and hide its content in the app switcher (a setting, off by default).
 */
export function AppLock({ children, optional = false }: { children: ReactNode; /** Lock only when the person turned it on (Profile → Lock Attendly). */ optional?: boolean }) {
  const { phase, signOut, audience } = useSession();
  const web = Platform.OS === 'web';
  const [state, setState] = useState<LockState>(web ? 'open' : 'checking');
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backgroundedAt = useRef<number | null>(null);
  const prompting = useRef(false);
  /** Signed in during this run (just typed the code): no second prompt, but the screen-lock rule still applies. */
  const freshLogin = useRef(false);
  if (phase === 'signed-out' || phase === 'needs-server') freshLogin.current = true;

  // Screenshot blocking is a choice (More → This phone), off by default.
  useEffect(() => {
    if (!web) void loadScreenshotSetting();
  }, [web]);

  /** Bumped for every prompt: a prompt that never answers (Android sometimes drops one shown while
   *  the app is still coming to the front) can't block the next tap on Unlock. */
  const attempt = useRef(0);
  const unlock = useCallback(async (force = false) => {
    if (web) return;
    if (prompting.current && !force) return;
    if (prompting.current) {
      // The person tapped Unlock while an earlier prompt is stuck: drop it and ask again.
      await LocalAuthentication.cancelAuthenticate().catch(() => undefined);
    }
    const mine = ++attempt.current;
    prompting.current = true;
    setError(null);
    try {
      if (optional && !(await loadPrefs()).appLock) {
        setState('open');
        return;
      }
      const level = await LocalAuthentication.getEnrolledLevelAsync().catch(() => LocalAuthentication.SecurityLevel.NONE);
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        // Optional lock and the phone's screen lock was removed since: nothing to check against.
        setState(optional ? 'open' : 'no-screen-lock');
        return;
      }
      if (freshLogin.current) {
        freshLogin.current = false;
        setState('open');
        return;
      }
      setState('locked');
      // Let the app finish coming to the front first — a prompt requested too early is silently dropped.
      if (AppState.currentState !== 'active') await new Promise((r) => setTimeout(r, 400));
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: `Unlock ${audience.appName}`,
        promptSubtitle: 'Fingerprint, face, or your phone’s PIN / pattern / password',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
        requireConfirmation: false,
      });
      if (mine !== attempt.current) return; // a newer prompt took over
      if (r.success) setState('open');
      else if (r.error === 'lockout') setError('Too many tries — wait 30 seconds, then tap Unlock.');
      else if (r.error === 'not_enrolled' || r.error === 'passcode_not_set' || r.error === 'not_available')
        setError('Your phone didn’t show its lock screen. Check Settings → Security has a PIN, pattern or password, then tap Unlock.');
      else if (r.error !== 'user_cancel' && r.error !== 'system_cancel' && r.error !== 'app_cancel') setError('Couldn’t confirm it’s you. Tap Unlock to try again.');
    } catch {
      if (mine === attempt.current) setError('Couldn’t start the unlock prompt. Tap Unlock to try again.');
    } finally {
      if (mine === attempt.current) prompting.current = false;
    }
  }, [web, optional, audience.appName]);

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
          // A moment after coming back, so Android actually shows the prompt.
          setTimeout(() => void unlock(), 350);
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

  // The app stays mounted underneath the lock (a half-taken register survives a relock);
  // the lock only covers it and swallows every touch.
  const locked = state !== 'open';
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={locked}>
        {state === 'checking' ? null : children}
      </View>
      {hidden && !locked ? <View style={[StyleSheet.absoluteFill, styles.shield]} /> : null}
      {locked ? (
        <View style={[StyleSheet.absoluteFill, styles.root]}>
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
                  This phone has no PIN, pattern, password or fingerprint. This account can see sensitive data, so {audience.appName} only runs on a locked phone. Add a screen lock in Settings → Security, then come back.
                </Text>
                <Button title="I’ve set it — check again" onPress={() => void unlock(true)} style={styles.btn} />
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
                {state === 'locked' ? <Button title="Unlock" onPress={() => void unlock(true)} style={styles.btn} /> : null}
              </>
            )}
            <Button title="Sign out" kind="ghost" onPress={() => void signOut()} style={{ marginTop: 8, alignSelf: 'stretch' }} />
          </View>
        </View>
      ) : null}
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
