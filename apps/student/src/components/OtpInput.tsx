import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { colors, fonts, radius, toneColor } from '@/theme';
import { Text } from './ui';

/** Six boxes over one hidden input — supports paste and SMS/email autofill. */
export function OtpInput({ value, onChange, invalid, disabled }: { value: string; onChange: (v: string) => void; invalid?: boolean; disabled?: boolean }) {
  const ref = useRef<TextInput>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 250);
    return () => clearTimeout(t);
  }, []);
  const digits = value.padEnd(6, ' ').slice(0, 6).split('');
  return (
    <Pressable onPress={() => ref.current?.focus()} accessibilityLabel="One-time code" accessibilityHint="Enter the 6-digit code">
      <View style={styles.row}>
        {digits.map((d, i) => {
          const active = !disabled && i === Math.min(value.length, 5);
          return (
            <View key={i} style={[styles.box, active && styles.active, invalid && { borderColor: toneColor.red.line }]}>
              <Text style={styles.digit}>{d.trim()}</Text>
            </View>
          );
        })}
      </View>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={(t) => onChange(t.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={6}
        editable={!disabled}
        caretHidden
        style={styles.hidden}
        importantForAutofill="yes"
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  box: {
    flex: 1,
    aspectRatio: 0.86,
    maxHeight: 64,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  active: { borderColor: 'rgba(34,211,238,0.6)', backgroundColor: 'rgba(34,211,238,0.06)' },
  digit: { fontFamily: fonts.monoMedium, fontSize: 24, color: colors.text },
  hidden: { position: 'absolute', opacity: 0, width: 1, height: 1 },
});
