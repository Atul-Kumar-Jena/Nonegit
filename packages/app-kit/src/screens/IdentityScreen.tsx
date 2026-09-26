import { View } from 'react-native';
import { ShieldAlert } from 'lucide-react-native';
import { Screen } from '../components/Screen';
import { Button, Card, IconTile, Text } from '../components/ui';
import { useSession } from '../state/session';
import { colors } from '../theme';

/** Shown when the server's signing identity no longer matches the pinned one. */
export default function IdentityError() {
  const { identityError, resetPhone } = useSession();
  return (
    <Screen scroll={false} contentStyle={{ justifyContent: 'center', gap: 16 }}>
      <IconTile tone="red" size={56}>
        <ShieldAlert color={colors.red} size={28} />
      </IconTile>
      <Text variant="title">Server identity changed</Text>
      <Card tone="red">
        <Text variant="body">{identityError ?? 'The server could not prove its identity.'}</Text>
      </Card>
      <Text variant="small">
        Attendly stopped to protect your account. If your institution confirms they moved to a new server, you can reset this phone and bind it again (an admin must approve the new binding).
      </Text>
      <View style={{ height: 8 }} />
      <Button title="Reset this phone" kind="danger" onPress={() => void resetPhone()} />
    </Screen>
  );
}
