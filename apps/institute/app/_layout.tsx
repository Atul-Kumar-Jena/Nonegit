import { useEffect } from 'react';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { useSession, type NotificationTarget } from '@kit/state/session';
import { OutboxRunner } from '@kit/components/OutboxRunner';
import { NotificationRunner } from '@kit/lib/notifications';
import { CrashScreen, RootShell } from '@kit/components/RootShell';
import { colors } from '@kit/theme';
import { AppLock } from '@/components/AppLock';
import { localSessions } from '@/local-sessions';
import { instituteOutboxHandlers } from '@/outbox-handlers';

const AUDIENCE = {
  appName: 'Attendly Institute',
  allowedRoles: ['teacher', 'admin'] as const,
  wrongRoleMessage: 'This app is for teachers and administrators. Students use the Attendly app.',
  requestsRoute: '/inbox',
  institutionGate: true,
  routeFor: (d: NotificationTarget) => (d.kind === 'access' ? '/more' : d.kind === 'request' ? '/inbox' : d.sessionId ? `/session/${d.sessionId}` : '/timetable'),
};

/** Offline class state belongs to the signed-in account: forget it on sign-out. */
function Housekeeping() {
  const { phase } = useSession();
  useEffect(() => {
    if (phase === 'signed-out' || phase === 'needs-server') void localSessions.wipe();
  }, [phase]);
  return null;
}

export default function RootLayout() {
  return (
    <RootShell audience={AUDIENCE}>
      <NotificationRunner />
      <OutboxRunner handlers={instituteOutboxHandlers} />
      <Housekeeping />
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
