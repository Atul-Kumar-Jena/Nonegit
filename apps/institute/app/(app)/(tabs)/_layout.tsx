import { Pressable, StyleSheet, View } from 'react-native';
import { Tabs, router } from 'expo-router';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CalendarDays, House, LayoutGrid, Library, Play } from 'lucide-react-native';
import { Text } from '@kit/components/ui';
import { colors, gradients } from '@kit/theme';

const ICONS = { home: House, timetable: CalendarDays, classes: Library, more: LayoutGrid } as const;
const LABELS = { home: 'Today', timetable: 'Timetable', classes: 'Classes', more: 'More' } as const;

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
      <Pressable accessibilityRole="button" accessibilityLabel="Take attendance now" onPress={() => router.push('/attend')} style={styles.centerWrap} hitSlop={6}>
        <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.center}>
          <Play color="#0a0a0a" size={22} strokeWidth={2.4} fill="#0a0a0a" />
        </LinearGradient>
      </Pressable>
      {items[2]}
      {items[3]}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}>
      <Tabs.Screen name="home" />
      <Tabs.Screen name="timetable" />
      <Tabs.Screen name="classes" />
      <Tabs.Screen name="more" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(10,10,10,0.97)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 8,
    paddingHorizontal: 8,
  },
  tab: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 4, minHeight: 48, justifyContent: 'center' },
  tabLabel: { fontSize: 11 },
  centerWrap: { flex: 1, alignItems: 'center' },
  center: {
    width: 54,
    height: 54,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -22,
    shadowColor: '#ffffff',
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 10,
  },
});
