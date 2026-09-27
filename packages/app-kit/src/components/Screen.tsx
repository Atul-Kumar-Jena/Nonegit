import { useEffect, useRef, type ReactNode } from 'react';
import { Dimensions, Keyboard, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';
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
  /** @deprecated Every screen keeps the field being typed in above the keyboard now. */
  keyboard?: boolean;
}) {
  void keyboard;
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  useKeepFocusedInputVisible(scroll ? scrollRef : null, scrollY);
  const body = scroll ? (
    <ScrollView
      ref={scrollRef}
      onScroll={(e) => (scrollY.current = e.nativeEvent.contentOffset.y)}
      scrollEventThrottle={32}
      keyboardDismissMode="on-drag"
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
    // Fixed screens (lists with their own scrolling, registers…) keep just the phone's bottom margin.
    <View style={[styles.content, { flex: 1, paddingBottom: Math.max(insets.bottom, 12) + 4 }, contentStyle]}>{children}</View>
  );
  return (
    <View style={styles.root}>
      <Backdrop />
      <SafeAreaView edges={edges} style={{ flex: 1 }}>
        {/* Android draws edge to edge, so the window no longer shrinks for the keyboard: pad on both platforms. */}
        {Platform.OS === 'web' ? (
          <>
            {body}
            {footer}
          </>
        ) : (
          <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
            {body}
            {footer ? <View style={{ paddingBottom: insets.bottom }}>{footer}</View> : null}
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    </View>
  );
}

/**
 * While the keyboard is up, the field being typed in is scrolled into view above it — also when
 * moving to the next field, and when the keyboard first appears.
 */
function useKeepFocusedInputVisible(ref: React.RefObject<ScrollView | null> | null, scrollY: React.RefObject<number>) {
  useEffect(() => {
    if (!ref || Platform.OS === 'web') return;
    let keyboardTop = 0;
    let lastInput: unknown = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const reveal = () => {
      const input = TextInput.State.currentlyFocusedInput?.();
      const sv = ref.current;
      if (!input || !sv || !keyboardTop) return;
      input.measureInWindow((_x, y, _w, h) => {
        const margin = 24;
        const overflow = y + h + margin - keyboardTop;
        const hiddenAbove = y < 80 ? 80 - y : 0;
        if (overflow > 0) sv.scrollTo({ y: Math.max(0, (scrollY.current ?? 0) + overflow), animated: true });
        else if (hiddenAbove > 0) sv.scrollTo({ y: Math.max(0, (scrollY.current ?? 0) - hiddenAbove), animated: true });
      });
    };
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      keyboardTop = e.endCoordinates.screenY || Dimensions.get('window').height - e.endCoordinates.height;
      lastInput = TextInput.State.currentlyFocusedInput?.();
      setTimeout(reveal, 60);
      // Moving between fields doesn't fire keyboard events: watch the focused field while it's up.
      if (!timer)
        timer = setInterval(() => {
          const now = TextInput.State.currentlyFocusedInput?.();
          if (now && now !== lastInput) {
            lastInput = now;
            reveal();
          }
        }, 250);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardTop = 0;
      if (timer) clearInterval(timer);
      timer = null;
    });
    return () => {
      show.remove();
      hide.remove();
      if (timer) clearInterval(timer);
    };
  }, [ref, scrollY]);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  // Bottom padding clears the tab bar, so the last item always scrolls fully into view.
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 140 },
});
