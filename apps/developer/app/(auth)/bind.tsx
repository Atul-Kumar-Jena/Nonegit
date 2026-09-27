import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@kit/components/Screen';
import { Button, Notice, Text } from '@kit/components/ui';
import BindScreen from '@kit/screens/BindScreen';
import { useSession } from '@kit/state/session';
import { colors } from '@kit/theme';
import { openConsole } from '@/open-console';

/** Testing mode binds the phone without another tap; a real developer confirms it on the usual screen. */
export default function Bind() {
  const { pendingDevice, bindDevice } = useSession();
  const [auto] = useState(openConsole.autoBind);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!auto || pendingDevice?.kind !== 'bind') return;
    openConsole.autoBind = false;
    bindDevice()
      .then(() => router.replace('/home'))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Couldn’t open the console.'));
  }, [auto, pendingDevice, bindDevice]);

  if (!auto) return <BindScreen />;
  return (
    <Screen contentStyle={{ paddingTop: 60, alignItems: 'center' }}>
      {error ? (
        <View style={{ alignSelf: 'stretch', gap: 14 }}>
          <Notice message={error} tone="red" />
          <Button title="Back" kind="ghost" onPress={() => router.replace('/login')} />
        </View>
      ) : (
        <>
          <ActivityIndicator color={colors.text} />
          <Text variant="body" style={{ marginTop: 14 }}>
            Opening the console…
          </Text>
        </>
      )}
    </Screen>
  );
}
