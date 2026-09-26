import { useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react-native';
import { Screen } from '../components/Screen';
import { Badge, Button, Card, Text } from '../components/ui';
import { markPermissionsOnboarded } from '../lib/notifications';
import { openAppSettings, type PermState, type PermissionItem } from '../lib/permissions';
import { colors } from '../theme';

/**
 * Asks for every permission the app needs, one clear card each: why it's needed,
 * an Allow button, and — if refused — what stops working and how to turn it on
 * later (App info → Permissions). Shown once after sign-in; reachable any time.
 */
export default function PermissionsScreen({ appName, items }: { appName: string; items: PermissionItem[] }) {
  const [state, setState] = useState<Record<string, PermState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [warned, setWarned] = useState(false);

  const refresh = useCallback(async () => {
    const entries = await Promise.all(items.map(async (i) => [i.key, await i.check()] as const));
    setState(Object.fromEntries(entries));
  }, [items]);

  useEffect(() => {
    void refresh();
    // Coming back from Settings: show the new state.
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void refresh());
    return () => sub.remove();
  }, [refresh]);

  async function ask(item: PermissionItem) {
    setBusy(item.key);
    try {
      const r = await item.request();
      setState((cur) => ({ ...cur, [item.key]: r }));
    } finally {
      setBusy(null);
    }
  }

  async function askAll() {
    for (const item of items) if (state[item.key] !== 'granted' && state[item.key] !== 'unavailable' && state[item.key] !== 'blocked') await ask(item);
  }

  const missing = items.filter((i) => state[i.key] === 'denied' || state[i.key] === 'blocked');
  const allDone = items.every((i) => state[i.key] === 'granted' || state[i.key] === 'unavailable');

  async function finish() {
    if (missing.length && !warned) {
      setWarned(true); // tell them once, clearly, what they're giving up
      return;
    }
    await markPermissionsOnboarded();
    if (router.canGoBack()) router.back();
    else router.replace('/home');
  }

  return (
    <Screen contentStyle={{ paddingTop: 12 }}>
      <View style={styles.header}>
        <ShieldCheck color={colors.cyan} size={26} />
        <View style={{ flex: 1 }}>
          <Text variant="title">Permissions</Text>
          <Text variant="small">{appName} asks only for what it needs, and only uses it when you do something.</Text>
        </View>
      </View>

      {!allDone ? <Button title="Allow all" onPress={() => void askAll()} style={{ marginTop: 16 }} /> : null}

      <View style={{ gap: 12, marginTop: 16 }}>
        {items.map((item) => {
          const st = state[item.key];
          const granted = st === 'granted';
          return (
            <Card key={item.key} tone={granted ? undefined : st === 'denied' || st === 'blocked' ? 'amber' : undefined} style={{ gap: 8 }}>
              <View style={styles.row}>
                <Text variant="bodyStrong" style={{ flex: 1 }}>
                  {item.title}
                  {item.required ? <Text variant="small"> · needed</Text> : null}
                </Text>
                {granted ? (
                  <Badge label="Allowed" tone="green" icon={<CheckCircle2 color={colors.green} size={11} />} />
                ) : st === 'unavailable' ? (
                  <Badge label="Not on this device" tone="muted" dot={false} />
                ) : st ? (
                  <Badge label="Not allowed" tone="amber" dot={false} />
                ) : null}
              </View>
              <Text variant="small" color={colors.text}>
                {item.why}
              </Text>
              {st === 'denied' || st === 'blocked' ? (
                <View style={styles.row}>
                  <AlertTriangle color={colors.amber} size={14} />
                  <Text variant="small" color={colors.amber} style={{ flex: 1 }}>
                    {item.ifDenied}
                  </Text>
                </View>
              ) : null}
              {!granted && st !== 'unavailable' ? (
                st === 'blocked' ? (
                  <Button title="Open settings to allow" kind="secondary" compact onPress={openAppSettings} />
                ) : (
                  <Button title="Allow" compact onPress={() => void ask(item)} loading={busy === item.key} />
                )
              ) : null}
            </Card>
          );
        })}
      </View>

      <Text variant="small" style={{ marginTop: 16 }}>
        You can change any of these later: Settings → Apps → {appName} → Permissions (or long-press the app icon → App info).
      </Text>

      {warned && missing.length ? (
        <Card tone="amber" style={{ marginTop: 14, gap: 8 }}>
          <Text variant="bodyStrong">Continue without {missing.map((m) => m.title.split(' (')[0]!.toLowerCase()).join(' and ')}?</Text>
          {missing.map((m) => (
            <Text key={m.key} variant="small" color={colors.text}>
              • {m.ifDenied}
            </Text>
          ))}
          <Button title="Open settings" kind="secondary" compact onPress={openAppSettings} />
        </Card>
      ) : null}

      <Button title={warned && missing.length ? 'Continue anyway' : allDone ? 'Done' : 'Continue'} kind={allDone ? 'primary' : 'secondary'} onPress={() => void finish()} style={{ marginTop: 16 }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
