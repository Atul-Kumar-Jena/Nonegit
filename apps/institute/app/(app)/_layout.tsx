import { Redirect, Stack } from 'expo-router';
import { useSession } from '@kit/state/session';
import { colors } from '@kit/theme';

export default function AppLayout() {
  const { phase } = useSession();
  if (phase === 'booting') return <Redirect href="/" />;
  if (phase === 'identity-error') return <Redirect href="/identity" />;
  if (phase !== 'signed-in') return <Redirect href="/login" />;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="live/[id]" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom', gestureEnabled: false }} />
    </Stack>
  );
}
