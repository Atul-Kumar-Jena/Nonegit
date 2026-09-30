import { forwardRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text as RNText,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { colors, fonts, gradients, radius, shadow, toneColor, type Tone } from '../theme';

// ───────────────────────────── text ─────────────────────────────

type Variant = 'display' | 'title' | 'heading' | 'body' | 'bodyStrong' | 'small' | 'label' | 'mono' | 'monoSmall';

const variantStyle: Record<Variant, TextStyle> = {
  display: { fontFamily: fonts.display, fontSize: 46, letterSpacing: -1, color: colors.text },
  title: { fontFamily: fonts.display, fontSize: 30, letterSpacing: -0.4, color: colors.text },
  heading: { fontFamily: fonts.bold, fontSize: 17, letterSpacing: -0.2, color: colors.text },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.textMuted },
  bodyStrong: { fontFamily: fonts.semibold, fontSize: 15, letterSpacing: -0.1, color: colors.text },
  small: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.textMuted },
  label: { fontFamily: fonts.bold, fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase', color: colors.textDim },
  mono: { fontFamily: fonts.mono, fontSize: 13, color: colors.text },
  monoSmall: { fontFamily: fonts.mono, fontSize: 11.5, color: colors.textMuted },
};

export function Text({ variant = 'body', color, style, ...rest }: TextProps & { variant?: Variant; color?: string }) {
  return <RNText allowFontScaling maxFontSizeMultiplier={1.4} {...rest} style={[variantStyle[variant], color ? { color } : null, style]} />;
}

// ───────────────────────────── surfaces ─────────────────────────────

export function Card({ children, style, tone, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: Tone; padded?: boolean }) {
  const t = tone ? toneColor[tone] : null;
  return (
    <View style={[styles.card, padded && { padding: 16 }, t && { borderColor: t.line, backgroundColor: blend(t.bg) }, style]}>
      <Edge />
      {children}
    </View>
  );
}

/** The lit top edge that makes a dark surface read as raised. */
export function Edge() {
  return <LinearGradient pointerEvents="none" colors={gradients.edge} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.edge} />;
}

function blend(bg: string) {
  // Tinted cards keep the dark base so text contrast stays high.
  return bg.replace(/[\d.]+\)$/, '0.06)');
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }, style]} />;
}

export function SectionLabel({ children, right }: { children: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionLabel}>
      <View style={styles.sectionTitle}>
        <View style={styles.sectionTick} />
        <Text variant="label">{children}</Text>
      </View>
      {right}
    </View>
  );
}

// ───────────────────────────── badge ─────────────────────────────

export function Badge({ label, tone = 'cyan', dot = true, icon }: { label: string; tone?: Tone; dot?: boolean; icon?: ReactNode }) {
  const t = toneColor[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg, borderColor: t.line }]} accessibilityRole="text" accessibilityLabel={label}>
      {icon ?? (dot ? <View style={[styles.dot, { backgroundColor: t.fg }]} /> : null)}
      <RNText style={[styles.badgeText, { color: t.fg }]} maxFontSizeMultiplier={1.3}>
        {label}
      </RNText>
    </View>
  );
}

// ───────────────────────────── buttons ─────────────────────────────

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  kind = 'primary',
  loading = false,
  disabled = false,
  icon,
  style,
  compact = false,
  accessibilityHint,
}: {
  title: string;
  onPress?: () => void;
  kind?: ButtonKind;
  loading?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
  accessibilityHint?: string;
}) {
  const inactive = disabled || loading;
  const textColor = kind === 'primary' ? colors.ink : kind === 'danger' ? colors.red : colors.text;
  const content = (
    <View style={[styles.btnInner, compact && styles.btnCompact]}>
      {loading ? <ActivityIndicator color={textColor} size="small" /> : null}
      {!loading ? (
        <>
          <RNText style={[styles.btnText, { color: textColor }, compact && { fontSize: 14 }]} maxFontSizeMultiplier={1.3} numberOfLines={1}>
            {title}
          </RNText>
          {icon}
        </>
      ) : null}
    </View>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => undefined);
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.btn,
        compact && { borderRadius: 12 },
        kind === 'primary' && styles.btnPrimary,
        kind === 'secondary' && [styles.btnSecondary, pressed && { backgroundColor: colors.border }],
        kind === 'danger' && styles.btnDanger,
        kind === 'ghost' && [styles.btnGhost, pressed && { backgroundColor: colors.cyanSoft }],
        { opacity: inactive ? 0.5 : pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] },
        style,
      ]}
    >
      {kind === 'primary' ? (
        <LinearGradient colors={gradients.button} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={styles.btnGradient}>
          {content}
        </LinearGradient>
      ) : kind === 'secondary' ? (
        <>
          <Edge />
          {content}
        </>
      ) : (
        content
      )}
    </Pressable>
  );
}

export function IconButton({ onPress, children, label, style }: { onPress: () => void; children: ReactNode; label: string; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.iconBtn, pressed && { backgroundColor: colors.border, transform: [{ scale: 0.96 }] }, style]}
    >
      <Edge />
      {children}
    </Pressable>
  );
}

export function PressableRow({ children, style, ...rest }: PressableProps & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable {...rest} style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }, style]}>
      {children}
    </Pressable>
  );
}

// ───────────────────────────── inputs ─────────────────────────────

export const Input = forwardRef<TextInput, TextInputProps & { icon?: ReactNode; invalid?: boolean }>(function Input({ icon, invalid, style, onFocus, onBlur, ...rest }, ref) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.input, focused && styles.inputFocused, invalid && { borderColor: toneColor.red.line }]}>
      {icon}
      <TextInput
        ref={ref}
        placeholderTextColor={colors.textDim}
        selectionColor={colors.cyan}
        style={[styles.inputText, style]}
        maxFontSizeMultiplier={1.3}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        {...rest}
      />
    </View>
  );
});

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => {
              if (!active) void Haptics.selectionAsync().catch(() => undefined);
              onChange(o.value);
            }}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <RNText style={[styles.segmentText, active && { color: colors.ink, fontFamily: fonts.semibold }]} maxFontSizeMultiplier={1.3} numberOfLines={1}>
              {o.label}
            </RNText>
          </Pressable>
        );
      })}
    </View>
  );
}

// ───────────────────────────── progress ─────────────────────────────

export function ProgressBar({ value, marker, tone = 'cyan', height = 6 }: { value: number | null; marker?: number; tone?: Tone; height?: number }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const fill = tone === 'amber' ? (['#fbbf24', '#f59e0b'] as const) : tone === 'red' ? (['#f87171', '#ef4444'] as const) : (['#ffffff', '#d4d4d4'] as const);
  return (
    <View
      style={[styles.track, { height, borderRadius: height }]}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(v) }}
    >
      <LinearGradient colors={fill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ width: `${v}%`, height: '100%', borderRadius: height }} />
      {marker !== undefined ? <View style={[styles.marker, { left: `${marker}%`, height: height + 6, top: -3 }]} /> : null}
    </View>
  );
}

// ───────────────────────────── misc ─────────────────────────────

export function Avatar({ text, size = 40 }: { text: string; size?: number }) {
  return (
    <LinearGradient colors={gradients.avatar} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}>
      <RNText style={{ fontFamily: fonts.bold, color: colors.ink, fontSize: size * 0.36, letterSpacing: 0.3 }} maxFontSizeMultiplier={1}>
        {text}
      </RNText>
    </LinearGradient>
  );
}

export function IconTile({ children, tone = 'cyan', size = 40 }: { children: ReactNode; tone?: Tone; size?: number }) {
  const t = toneColor[tone];
  return <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.32), backgroundColor: t.bg, borderWidth: 1, borderColor: t.line, alignItems: 'center', justifyContent: 'center' }}>{children}</View>;
}

export function InfoRow({ label, value, valueColor, mono = true }: { label: string; value: string; valueColor?: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text variant="small" style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Text variant={mono ? 'mono' : 'bodyStrong'} color={valueColor} style={{ textAlign: 'right', flexShrink: 1 }} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.cyan} />
      {label ? <Text variant="small" style={{ marginTop: 12 }}>{label}</Text> : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card tone="red" style={{ gap: 12 }}>
      <Text variant="bodyStrong">Couldn’t load this</Text>
      <Text variant="small">{message}</Text>
      {onRetry ? <Button title="Try again" kind="secondary" compact onPress={onRetry} /> : null}
    </Card>
  );
}

export function Notice({ message, tone = 'amber', onDismiss }: { message: string; tone?: Tone; onDismiss?: () => void }) {
  const t = toneColor[tone];
  return (
    <Pressable onPress={onDismiss} accessibilityRole={onDismiss ? 'button' : 'text'} accessibilityHint={onDismiss ? 'Dismiss' : undefined} style={[styles.notice, { borderColor: t.line, backgroundColor: t.bg }]}>
      <Text variant="small" color={t.fg}>
        {message}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden' },
  edge: { position: 'absolute', top: 0, left: 0, right: 0, height: 1 },
  sectionLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 28, marginBottom: 12, minHeight: 20 },
  sectionTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTick: { width: 3, height: 12, borderRadius: 2, backgroundColor: colors.textDim },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' },
  badgeText: { fontFamily: fonts.semibold, fontSize: 11.5, letterSpacing: 0.1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  btn: { borderRadius: 16, overflow: 'hidden', minHeight: 52 },
  btnPrimary: { ...shadow, shadowColor: '#ffffff', shadowOpacity: 0.12, shadowRadius: 14, shadowOffset: { width: 0, height: 4 } },
  btnGradient: { flex: 1 },
  btnInner: { flex: 1, minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 20 },
  btnCompact: { minHeight: 42, paddingHorizontal: 14 },
  btnText: { fontFamily: fonts.bold, fontSize: 15, letterSpacing: -0.1 },
  btnSecondary: { backgroundColor: colors.cardHi, borderWidth: 1, borderColor: colors.borderHi },
  btnDanger: { backgroundColor: 'rgba(248,113,113,0.10)', borderWidth: 1, borderColor: 'rgba(248,113,113,0.38)' },
  btnGhost: { backgroundColor: 'transparent' },
  iconBtn: { width: 42, height: 42, borderRadius: 14, borderWidth: 1, borderColor: colors.borderHi, backgroundColor: colors.cardHi, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  input: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised, paddingHorizontal: 14 },
  inputFocused: { borderColor: 'rgba(255, 255, 255, 0.55)', backgroundColor: colors.card },
  inputText: { flex: 1, color: colors.text, fontFamily: fonts.medium, fontSize: 16, paddingVertical: 12 },
  segmented: { flexDirection: 'row', backgroundColor: colors.bgRaised, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  segmentActive: { backgroundColor: colors.text },
  segmentText: { fontFamily: fonts.medium, fontSize: 13, color: colors.textMuted },
  track: { backgroundColor: 'rgba(255,255,255,0.10)', overflow: 'visible', width: '100%' },
  marker: { position: 'absolute', width: 2, marginLeft: -1, backgroundColor: 'rgba(255,255,255,0.55)', borderRadius: 1 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16, paddingVertical: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  notice: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 11 },
});
