import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme';

/** Near-black canvas with one soft grey glow, like attendly's site. */
export function Backdrop() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient colors={['rgba(255, 255, 255, 0.07)', 'rgba(255, 255, 255, 0)']} start={{ x: 0.9, y: 0 }} end={{ x: 0.35, y: 0.5 }} style={StyleSheet.absoluteFill} />
    </View>
  );
}

export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  edges = ['top'],
  contentStyle,
  footer,
  keyboard = false,
}: {
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  edges?: Edge[];
  contentStyle?: StyleProp<ViewStyle>;
  footer?: ReactNode;
  keyboard?: boolean;
}) {
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[styles.content, contentStyle]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator
      persistentScrollbar
      indicatorStyle="white"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.cyan} colors={[colors.cyan]} progressBackgroundColor={colors.card} /> : undefined}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.content, { flex: 1 }, contentStyle]}>{children}</View>
  );
  return (
    <View style={styles.root}>
      <Backdrop />
      <SafeAreaView edges={edges} style={{ flex: 1 }}>
        {keyboard ? (
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            {body}
            {footer}
          </KeyboardAvoidingView>
        ) : (
          <>
            {body}
            {footer}
          </>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  // Bottom padding clears the tab bar, so the last item always scrolls fully into view.
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 140 },
});
