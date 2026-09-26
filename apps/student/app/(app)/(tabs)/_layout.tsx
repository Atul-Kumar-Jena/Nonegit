import { Pressable, StyleSheet, View } from 'react-native';
import { Tabs, router } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BookOpen, House, ScanLine, UserRound } from 'lucide-react-native';
import { Text } from '@/components/ui';
import { colors, gradients } from '@/theme';

const ICONS = { home: House, subjects: BookOpen, profile: UserRound } as const;
const LABELS = { home: 'Home', subjects: 'Subjects', profile: 'Profile' } as const;

function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const items = state.routes.map((route, index) => {
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
        {Icon ? <Icon color={focused ? colors.cyan : colors.textDim} size={21} strokeWidth={focused ? 2.2 : 1.8} /> : null}
        <Text style={[styles.tabLabel, { color: focused ? colors.cyan : colors.textDim }]}>{LABELS[name] ?? route.name}</Text>
      </Pressable>
    );
  });
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      {items[0]}
      {items[1]}
      <Pressable accessibilityRole="button" accessibilityLabel="Scan attendance QR" onPress={() => router.push('/scan')} style={styles.scanWrap} hitSlop={6}>
        <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.scan}>
          <ScanLine color="#04141c" size={24} strokeWidth={2.2} />
        </LinearGradient>
      </Pressable>
      {items[2]}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}>
      <Tabs.Screen name="home" />
      <Tabs.Screen name="subjects" />
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
  scanWrap: { flex: 1, alignItems: 'center' },
  scan: {
    width: 54,
    height: 54,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -22,
    shadowColor: '#22d3ee',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
});
