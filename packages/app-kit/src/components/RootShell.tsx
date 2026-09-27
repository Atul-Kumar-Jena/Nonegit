import { useEffect, type ReactNode } from 'react';
import { installNavigationGuard } from '../lib/nav-guard';
import { StyleSheet, View } from 'react-native';
import { router, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as SystemUI from 'expo-system-ui';
import { useFonts } from 'expo-font';
// Per-weight imports keep unused font files out of the bundle.
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';
import type { AppAudience } from '../state/session';
import { colors } from '../theme';
import { AppProviders } from './AppProviders';
import { Backdrop } from './Screen';
import { Button, Text } from './ui';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);
void SystemUI.setBackgroundColorAsync(colors.bg).catch(() => undefined);
installNavigationGuard();
// Browser test builds only (EXPO_PUBLIC_E2E=1 at build time; never set for phone builds): lets the
// screenshot script move between screens without a page reload, which would sign the web build out.
if (process.env.EXPO_PUBLIC_E2E === '1' && typeof window !== 'undefined') (window as unknown as { __router: typeof router }).__router = router;

/** Fonts, splash handling and providers — the same boot sequence for every Attendly app. */
export function RootShell({ audience, children }: { audience: AppAudience; children: ReactNode }) {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });
  const ready = fontsLoaded || !!fontError; // never block the app on a font failure
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <AppProviders audience={audience}>
      <StatusBar style="light" />
      {children}
    </AppProviders>
  );
}

/** Last line of defence: any render crash shows this instead of a white screen. */
export function CrashScreen({ error, retry, appName }: ErrorBoundaryProps & { appName: string }) {
  return (
    <View style={styles.crash}>
      <Backdrop />
      <Text variant="label">{appName}</Text>
      <Text variant="title" style={{ marginTop: 8 }}>
        Something went wrong
      </Text>
      <Text variant="body" style={{ marginTop: 8, marginBottom: 24 }}>
        The app hit an unexpected problem and stopped this screen safely. Your data is safe. {__DEV__ ? `\n\n${error.message}` : ''}
      </Text>
      <Button title="Reload" onPress={() => void retry()} />
    </View>
  );
}

const styles = StyleSheet.create({
  crash: { flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: 'center' },
});
