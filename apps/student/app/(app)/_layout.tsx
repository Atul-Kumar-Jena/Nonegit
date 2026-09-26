import { Redirect, Stack } from 'expo-router';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

export default function AppLayout() {
  const { phase } = useSession();
  if (phase === 'booting') return <Redirect href="/" />;
  if (phase === 'identity-error') return <Redirect href="/identity" />;
  if (phase !== 'signed-in') return <Redirect href="/login" />;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="result" options={{ animation: 'fade', gestureEnabled: false }} />
    </Stack>
  );
}
