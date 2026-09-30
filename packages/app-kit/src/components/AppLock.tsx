import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Fingerprint, ShieldAlert } from 'lucide-react-native';
import { loadScreenshotSetting } from '../lib/screenshots';
import { loadPrefs } from '../lib/prefs';
import { authPromptBusy, authenticate } from '../lib/biometrics';
import { LogoMark } from './Logo';
import { Backdrop } from './Screen';
import { Button, Text } from './ui';
import { useSession } from '../state/session';
import { colors, fonts } from '../theme';

/** How long the app may sit in the background before it asks again. */
const RELOCK_AFTER_MS = 30_000;

type LockState = 'checking' | 'locked' | 'no-screen-lock' | 'open';

/**
 * Institute and Developer phones hold student data, live QR secrets or platform controls, so these apps
 * always lock; the Student app locks only when its owner turned it on (Profile → Lock Attendly).
 *  • no screen lock on the phone → the always-locking apps refuse to run;
 *  • fingerprint / face / phone PIN on launch, and after 30 s in the background;
 *  • our own prompts (the PIN screen is a separate window on Android) never trigger a relock;
 *  • with the optional lock off nothing is shown at all — no flash of a lock screen.
 */
export function AppLock({ children, optional = false }: { children: ReactNode; /** Lock only when the person turned it on. */ optional?: boolean }) {
  const { phase, signOut, audience } = useSession();
  const web = Platform.OS === 'web';
  const [state, setState] = useState<LockState>(web ? 'open' : 'checking');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const backgroundedAt = useRef<number | null>(null);
  /** Signed in during this run (just typed the code): no second prompt right away. */
  const freshLogin = useRef(false);
  if (phase === 'signed-out' || phase === 'needs-server') freshLogin.current = true;

  useEffect(() => {
    if (!web) void loadScreenshotSetting();
  }, [web]);

  /** Does this app need the lock right now? (Optional lock: only when turned on.) */
  const required = useCallback(async (): Promise<'yes' | 'no' | 'no-screen-lock'> => {
    if (optional && !(await loadPrefs()).appLock) return 'no';
    const level = await LocalAuthentication.getEnrolledLevelAsync().catch(() => LocalAuthentication.SecurityLevel.NONE);
    if (level === LocalAuthentication.SecurityLevel.NONE) return optional ? 'no' : 'no-screen-lock';
    return 'yes';
  }, [optional]);

  const attempt = useRef(0);
  /** Show the phone's own prompt; a newer call replaces an older one that never answered. */
  const prompt = useCallback(async () => {
    const mine = ++attempt.current;
    setBusy(true);
    setError(null);
    try {
      if (authPromptBusy()) await LocalAuthentication.cancelAuthenticate().catch(() => undefined);
      // A prompt requested while the app is still coming to the front is silently dropped by Android.
      if (AppState.currentState !== 'active') await new Promise((r) => setTimeout(r, 400));
      const r = await authenticate({
        promptMessage: `Unlock ${audience.appName}`,
        promptSubtitle: 'Fingerprint, face, or your phone’s PIN / pattern',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
        requireConfirmation: false,
      });
      if (mine !== attempt.current) return;
      if (r.success) {
        backgroundedAt.current = null;
        setState('open');
      } else if (r.error === 'lockout') setError('Too many tries. Wait 30 seconds, then tap Unlock.');
      else if (r.error === 'not_enrolled' || r.error === 'passcode_not_set' || r.error === 'not_available')
        setError('Your phone didn’t show its lock screen. Check Settings → Security has a PIN, pattern or password, then tap Unlock.');
      else if (r.error !== 'user_cancel' && r.error !== 'system_cancel' && r.error !== 'app_cancel') setError('Couldn’t confirm it’s you. Tap Unlock to try again.');
    } catch {
      if (mine === attempt.current) setError('Couldn’t start the unlock prompt. Tap Unlock to try again.');
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  }, [audience.appName]);

  /** Decide first, then (only if needed) cover the app and ask. */
  const lockIfNeeded = useCallback(
    async (reason: 'launch' | 'return' | 'retry') => {
      const need = await required();
      if (need === 'no') return setState('open');
      if (need === 'no-screen-lock') return setState('no-screen-lock');
      if (reason === 'launch' && freshLogin.current) {
        freshLogin.current = false;
        return setState('open');
      }
      setState('locked');
      await prompt();
    },
    [required, prompt],
  );

  // On launch (once signed in); start over after a sign-out.
  useEffect(() => {
    if (web) return;
    if (phase !== 'signed-in') {
      if (phase !== 'booting' && state !== 'checking') setState('checking');
      return;
    }
    if (state === 'checking') void lockIfNeeded('launch');
  }, [phase, state, lockIfNeeded, web]);

  // One subscription for the whole life of the app; it reads the latest state through refs.
  useEffect(() => {
    if (web) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background') {
        // Leaving because of our own fingerprint / PIN prompt doesn't count as leaving.
        if (!authPromptBusy() && backgroundedAt.current === null) backgroundedAt.current = Date.now();
        return;
      }
      if (s !== 'active' || phaseRef.current !== 'signed-in' || authPromptBusy()) return;
      const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
      backgroundedAt.current = null;
      if (stateRef.current === 'locked') setTimeout(() => void prompt(), 350);
      else if (stateRef.current === 'no-screen-lock') void lockIfNeeded('retry');
      else if (stateRef.current === 'open' && away > RELOCK_AFTER_MS) void lockIfNeeded('return');
    });
    return () => sub.remove();
  }, [web, prompt, lockIfNeeded]);

  // Signed-out screens (login, bind) don't hold any data: no lock there.
  if (web || phase !== 'signed-in') return <>{children}</>;

  // The app stays mounted underneath (a half-taken register survives a relock); the cover swallows every touch.
  const covered = state === 'locked' || state === 'no-screen-lock';
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }} importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={covered}>
        {state === 'checking' ? null : children}
      </View>
      {covered ? (
        <View style={[StyleSheet.absoluteFill, styles.root]}>
          <Backdrop />
          <View style={styles.center}>
            <LogoMark size={48} />
            <Text style={styles.app}>{audience.appName}</Text>
            {state === 'no-screen-lock' ? (
              <>
                <View style={[styles.badge, { borderColor: 'rgba(251,191,36,0.4)' }]}>
                  <ShieldAlert color={colors.amber} size={26} />
                </View>
                <Text variant="title" style={styles.text}>
                  Set a screen lock first
                </Text>
                <Text variant="body" style={styles.text}>
                  This phone has no PIN, pattern or password. {audience.appName} holds sensitive data, so it only runs on a locked phone. Add one in Settings → Security, then come back.
                </Text>
                <Button title="I’ve set it — check again" onPress={() => void lockIfNeeded('retry')} style={styles.btn} />
              </>
            ) : (
              <>
                <View style={styles.badge}>
                  <Fingerprint color={colors.text} size={30} />
                </View>
                <Text variant="title" style={styles.text}>
                  Welcome back
                </Text>
                <Text variant="body" style={styles.text}>
                  Unlock with your fingerprint, face or phone PIN.
                </Text>
                {error ? (
                  <Text variant="small" color={colors.red} style={styles.text}>
                    {error}
                  </Text>
                ) : null}
                {/* Always tappable: a prompt Android dropped silently must never leave the person stuck. */}
                <Button title={busy ? 'Unlock again' : 'Unlock'} onPress={() => void prompt()} style={styles.btn} />
              </>
            )}
            <Button title="Sign out" kind="ghost" onPress={() => void signOut()} style={{ marginTop: 6, alignSelf: 'stretch' }} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  app: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textMuted, marginTop: 10, letterSpacing: 0.3 },
  badge: { marginTop: 36, width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderHi, backgroundColor: colors.cardHi },
  text: { textAlign: 'center', marginTop: 12 },
  btn: { alignSelf: 'stretch', marginTop: 28 },
});
