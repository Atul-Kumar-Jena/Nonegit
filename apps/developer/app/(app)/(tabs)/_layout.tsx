import { Pressable, StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Building2, Flag, ScrollText, TerminalSquare, UserCog } from 'lucide-react-native';
import { Text } from '@kit/components/ui';
import { colors } from '@kit/theme';

const ICONS = { home: TerminalSquare, audit: ScrollText, flags: Flag, tenants: Building2, profile: UserCog } as const;
const LABELS = { home: 'Console', audit: 'Audit', flags: 'Flags', tenants: 'Tenants', profile: 'Profile' } as const;

function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      {state.routes.map((route, index) => {
        const name = route.name as keyof typeof ICONS;
        const Icon = ICONS[name];
        const focused = state.index === index;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={LABELS[name]}
            onPress={() => {
              const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !e.defaultPrevented) navigation.navigate(route.name);
            }}
            style={styles.tab}
          >
            {Icon ? <Icon color={focused ? colors.violet : colors.textDim} size={21} strokeWidth={focused ? 2.2 : 1.8} /> : null}
            <Text style={[styles.tabLabel, { color: focused ? colors.violet : colors.textDim }]}>{LABELS[name] ?? route.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}>
      <Tabs.Screen name="home" />
      <Tabs.Screen name="audit" />
      <Tabs.Screen name="flags" />
      <Tabs.Screen name="tenants" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(8,13,28,0.98)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 8,
    paddingHorizontal: 8,
  },
  tab: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 4, minHeight: 48, justifyContent: 'center' },
  tabLabel: { fontSize: 11 },
});
