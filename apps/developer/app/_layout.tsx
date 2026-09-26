import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { AppLock } from '@kit/components/AppLock';
import { CrashScreen, RootShell } from '@kit/components/RootShell';
import { colors } from '@kit/theme';

const AUDIENCE = {
  appName: 'Attendly Developer',
  allowedRoles: ['developer'] as const,
  wrongRoleMessage: 'This console is for Attendly developers only. Staff use Attendly Institute; students use Attendly.',
};

export default function RootLayout() {
  return (
    <RootShell audience={AUDIENCE}>
      <AppLock>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(app)" />
          <Stack.Screen name="identity" />
        </Stack>
      </AppLock>
    </RootShell>
  );
}

export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <CrashScreen {...props} appName="Attendly Developer" />;
}
