import { Redirect, Stack } from 'expo-router';
import { useSession } from '@kit/state/session';
import { colors } from '@kit/theme';

export default function AuthLayout() {
  const { phase } = useSession();
  if (phase === 'booting') return <Redirect href="/" />;
  if (phase === 'signed-in') return <Redirect href="/home" />;
  if (phase === 'identity-error') return <Redirect href="/identity" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }} />;
}
