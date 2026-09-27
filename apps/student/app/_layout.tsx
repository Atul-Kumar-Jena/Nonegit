import type { NotificationTarget } from '@kit/state/session';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { AppLock } from '@kit/components/AppLock';
import { OutboxRunner } from '@kit/components/OutboxRunner';
import { NotificationRunner } from '@kit/lib/notifications';
import { CrashScreen, RootShell } from '@kit/components/RootShell';
import { colors } from '@kit/theme';
import { studentOutboxHandlers } from '@/outbox-handlers';

const AUDIENCE = {
  appName: 'Attendly',
  allowedRoles: ['student'] as const,
  wrongRoleMessage: 'This is the student app. Staff accounts sign in with the Attendly Institute app.',
  requestsRoute: '/requests',
  routeFor: (d: NotificationTarget) =>
    d.kind === 'notice' && d.noticeId
      ? `/notice/${d.noticeId}`
      : d.kind === 'request'
        ? '/requests'
        : d.kind === 'device'
          ? '/profile'
          : d.kind === 'security'
            ? '/security'
            : d.courseId
              ? `/subject/${d.courseId}`
              : '/timetable',
};

export default function RootLayout() {
  return (
    <RootShell audience={AUDIENCE}>
      <NotificationRunner />
      <OutboxRunner handlers={studentOutboxHandlers} />
      {/* Fingerprint / phone lock to open the app, when the student turns it on in Profile. */}
      <AppLock optional>
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
  return <CrashScreen {...props} appName="Attendly" />;
}
