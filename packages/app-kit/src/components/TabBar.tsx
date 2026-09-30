import type { ComponentType, ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { colors, fonts, gradients } from '../theme';
import { Text } from './ui';

export type TabIcon = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;

/**
 * The bottom bar every Attendly app shares: four tabs, the selected one sitting in a soft pill,
 * and (optionally) one raised main action in the middle — Scan for students, Take attendance for staff.
 */
export function AppTabBar({
  state,
  navigation,
  tabs,
  action,
}: BottomTabBarProps & {
  tabs: Record<string, { label: string; icon: TabIcon }>;
  action?: { label: string; icon: ReactNode; onPress: () => void };
}) {
  const insets = useSafeAreaInsets();
  const items = state.routes.map((route, index) => {
    const tab = tabs[route.name];
    if (!tab) return null;
    const Icon = tab.icon;
    const focused = state.index === index;
    return (
      <Pressable
        key={route.key}
        accessibilityRole="tab"
        accessibilityState={{ selected: focused }}
        accessibilityLabel={tab.label}
        onPress={() => {
          const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !e.defaultPrevented) {
            void Haptics.selectionAsync().catch(() => undefined);
            navigation.navigate(route.name);
          }
        }}
        style={styles.tab}
      >
        <View style={[styles.pill, focused && styles.pillOn]}>
          <Icon color={focused ? colors.text : colors.textDim} size={20} strokeWidth={focused ? 2.2 : 1.8} />
        </View>
        <Text style={[styles.label, focused && styles.labelOn]} numberOfLines={1}>
          {tab.label}
        </Text>
      </Pressable>
    );
  });
  const half = Math.ceil(items.length / 2);
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <LinearGradient pointerEvents="none" colors={gradients.edge} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.edge} />
      {action ? (
        <>
          {items.slice(0, half)}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
              action.onPress();
            }}
            style={styles.actionWrap}
            hitSlop={6}
          >
            {({ pressed }) => (
              <View style={[styles.actionRing, pressed && { transform: [{ scale: 0.95 }] }]}>
                <LinearGradient colors={gradients.brand} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.action}>
                  {action.icon}
                </LinearGradient>
              </View>
            )}
          </Pressable>
          {items.slice(half)}
        </>
      ) : (
        items
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgRaised,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderHi,
    paddingTop: 8,
    paddingHorizontal: 6,
  },
  edge: { position: 'absolute', top: 0, left: 0, right: 0, height: 1 },
  tab: { flex: 1, alignItems: 'center', gap: 3, minHeight: 50, justifyContent: 'center' },
  pill: { width: 52, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  pillOn: { backgroundColor: 'rgba(255, 255, 255, 0.10)', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.14)' },
  label: { fontFamily: fonts.medium, fontSize: 11, color: colors.textDim },
  labelOn: { fontFamily: fonts.bold, color: colors.text },
  actionWrap: { flex: 1, alignItems: 'center' },
  actionRing: { marginTop: -26, padding: 5, borderRadius: 24, backgroundColor: colors.bgRaised, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.borderHi },
  action: {
    width: 54,
    height: 54,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ffffff',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 3 },
    elevation: 8,
  },
});
