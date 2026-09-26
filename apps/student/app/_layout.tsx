import { useEffect, useState } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
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
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiRequestError } from '@kit/lib/api-core';
import { SessionProvider } from '@kit/state/session';
import { Button, Text } from '@kit/components/ui';
import { Backdrop } from '@kit/components/Screen';
import { colors } from '@kit/theme';

const AUDIENCE = {
  appName: 'Attendly',
  allowedRoles: ['student'] as const,
  wrongRoleMessage: 'This is the student app. Staff accounts sign in with the Attendly Institute app.',
};

void SplashScreen.preventAutoHideAsync().catch(() => undefined);
void SystemUI.setBackgroundColorAsync(colors.bg).catch(() => undefined);

// Refetch when the app returns to the foreground.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (s) => focusManager.setFocused(s === 'active'));
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 10 * 60_000,
        retry: (count, err) => err instanceof ApiRequestError && err.transient && count < 2,
        retryDelay: (n) => Math.min(1000 * 2 ** n, 5000),
      },
      mutations: { retry: false },
    },
  });
}

export default function RootLayout() {
  const [queryClient] = useState(makeQueryClient);
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
    <SafeAreaProvider style={{ backgroundColor: colors.bg }}>
      <QueryClientProvider client={queryClient}>
        <SessionProvider audience={AUDIENCE}>
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(app)" />
            <Stack.Screen name="identity" />
          </Stack>
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/** Last line of defence: any render crash shows this instead of a white screen. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={styles.crash}>
      <Backdrop />
      <Text variant="label">Attendly</Text>
      <Text variant="title" style={{ marginTop: 8 }}>
        Something went wrong
      </Text>
      <Text variant="body" style={{ marginTop: 8, marginBottom: 24 }}>
        The app hit an unexpected problem and stopped safely. No attendance was recorded incorrectly. {__DEV__ ? `\n\n${error.message}` : ''}
      </Text>
      <Button title="Reload" onPress={() => void retry()} />
    </View>
  );
}

const styles = StyleSheet.create({
  crash: { flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: 'center' },
});
