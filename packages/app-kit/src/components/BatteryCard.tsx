import { Pressable, View } from 'react-native';
import { BatteryCharging, X } from 'lucide-react-native';
import { useBatteryNudge } from '../lib/battery';
import { openAppSettings } from '../lib/permissions';
import { colors } from '../theme';
import { Button, Card, Text } from './ui';

/** Android only, until done: "turn off battery optimisation so notifications arrive on time". */
export function BatteryCard() {
  const b = useBatteryNudge();
  if (!b.show) return null;
  return (
    <Card tone="amber" style={{ marginTop: 14, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <BatteryCharging color={colors.amber} size={20} />
        <Text variant="bodyStrong" style={{ flex: 1 }}>
          Get notifications on time
        </Text>
        <Pressable onPress={() => void b.dismiss()} accessibilityRole="button" accessibilityLabel="Not now" hitSlop={10}>
          <X color={colors.textDim} size={18} />
        </Pressable>
      </View>
      <Text variant="small">
        Android’s battery saver can delay class changes and reminders by hours. Tap below and choose <Text variant="small" color={colors.text}>Allow</Text> — it barely affects battery life.
      </Text>
      {b.oem ? (
        <Text variant="small">
          {`On ${b.oem} phones also open App info → Battery / Autostart and allow the app to run in the background.`}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button title="Turn off battery optimisation" compact onPress={() => void b.fix()} style={{ flex: 1 }} />
        {b.oem ? <Button title="App info" kind="secondary" compact onPress={openAppSettings} /> : null}
      </View>
    </Card>
  );
}
