import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../theme';

/** Dark canvas with the soft cyan/violet glows from the design. */
export function Backdrop() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient colors={['rgba(34,211,238,0.10)', 'rgba(34,211,238,0)']} start={{ x: 1, y: 0 }} end={{ x: 0.3, y: 0.45 }} style={StyleSheet.absoluteFill} />
      <LinearGradient colors={['rgba(139,92,246,0)', 'rgba(139,92,246,0.07)']} start={{ x: 0.7, y: 0.5 }} end={{ x: 0, y: 1 }} style={StyleSheet.absoluteFill} />
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
      showsVerticalScrollIndicator={false}
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
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32 },
});
