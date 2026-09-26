import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { OutboxRunner } from '@kit/components/OutboxRunner';
import { CrashScreen, RootShell } from '@kit/components/RootShell';
import { colors } from '@kit/theme';
import { AppLock } from '@/components/AppLock';
import { instituteOutboxHandlers } from '@/outbox-handlers';

const AUDIENCE = {
  appName: 'Attendly Institute',
  allowedRoles: ['teacher', 'admin'] as const,
  wrongRoleMessage: 'This app is for teachers and administrators. Students use the Attendly app.',
};

export default function RootLayout() {
  return (
    <RootShell audience={AUDIENCE}>
      <OutboxRunner handlers={instituteOutboxHandlers} />
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
  return <CrashScreen {...props} appName="Attendly Institute" />;
}
