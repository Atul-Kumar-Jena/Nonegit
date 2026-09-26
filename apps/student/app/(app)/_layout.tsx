import { Redirect, Stack } from 'expo-router';
import { useSession } from '@kit/state/session';
import { colors } from '@kit/theme';
import { ReminderRunner } from '@/components/ReminderRunner';

export default function AppLayout() {
  const { phase } = useSession();
  if (phase === 'booting') return <Redirect href="/" />;
  if (phase === 'identity-error') return <Redirect href="/identity" />;
  if (phase !== 'signed-in') return <Redirect href="/login" />;
  return (
    <>
      <ReminderRunner />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="scan" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="result" options={{ animation: 'fade', gestureEnabled: false }} />
      </Stack>
    </>
  );
}
