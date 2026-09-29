import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, Check, ChevronDown, Minus, Plus, Search, X } from 'lucide-react-native';
import { IconButton, Input, Text } from '@kit/components/ui';
import { InfoButton } from '@kit/components/Features';
import { HELP } from '@/help';
import { parseDate, parseTime } from '@/time-parse';
export { parseDate, parseTime };
import { colors, fonts, radius } from '@kit/theme';

/** Top bar: back button, title, optional action on the right. */
export function Header({ title, subtitle, right, onBack, info }: { title: string; subtitle?: string; right?: ReactNode; onBack?: () => void; info?: keyof typeof HELP }) {
  return (
    <View style={styles.header}>
      <IconButton label="Back" onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/home')))}>
        <ArrowLeft color={colors.text} size={18} />
      </IconButton>
      <View style={{ flex: 1 }}>
        {subtitle ? (
          <Text variant="label" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <Text variant="heading" numberOfLines={1}>
          {title}
        </Text>
      </View>
      {right}
      {info ? <InfoButton title={HELP[info]!.title} text={HELP[info]!.text} /> : null}
    </View>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text variant="label" style={{ marginBottom: 8 }}>
        {label}
      </Text>
      {children}
      {error ? (
        <Text variant="small" color={colors.red} style={{ marginTop: 6 }}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="small" style={{ marginTop: 6 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** A row of mutually-exclusive chips. */
export function Chips<T extends string | number>({ value, options, onChange }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={styles.chips}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={String(o.value)} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]}>
            <Text style={[styles.chipText, on && { color: colors.text }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ToggleRow({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <View style={styles.toggle}>
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong">{label}</Text>
        {hint ? <Text variant="small">{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ true: colors.cyan, false: colors.borderHi }}
        thumbColor="#ffffff"
        ios_backgroundColor={colors.borderHi}
        accessibilityLabel={label}
      />
    </View>
  );
}

export function Checkbox({ checked, tone = 'cyan', size = 24 }: { checked: boolean; tone?: 'cyan' | 'green' | 'amber'; size?: number }) {
  const c = tone === 'green' ? colors.green : tone === 'amber' ? colors.amber : colors.cyan;
  return (
    <View style={[styles.box, { width: size, height: size, borderColor: checked ? c : colors.borderHi, backgroundColor: checked ? c : 'transparent' }]}>
      {checked ? <Check color="#0a0a0a" size={size - 8} strokeWidth={3} /> : null}
    </View>
  );
}

export function Empty({ title, message, action }: { title: string; message?: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Text variant="bodyStrong" style={{ textAlign: 'center' }}>
        {title}
      </Text>
      {message ? (
        <Text variant="small" style={{ textAlign: 'center', marginTop: 6 }}>
          {message}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: 14, alignSelf: 'stretch' }}>{action}</View> : null}
    </View>
  );
}

/** Cross-platform confirm dialog. */
export function confirmAction(title: string, message: string, action: string, run: () => void, destructive = false) {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(`${title}\n\n${message}`)) run();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: action, style: destructive ? 'destructive' : 'default', onPress: run },
  ]);
}

export function Sheet({ open, onClose, title, children, scroll = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; scroll?: boolean }) {
  const sheetInsets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: 24 + sheetInsets.bottom }]}>
          <View style={styles.grabber} />
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text variant="heading" style={{ flex: 1 }}>
              {title}
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10}>
              <X color={colors.textMuted} size={20} />
            </Pressable>
          </View>
          {scroll ? (
            <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator persistentScrollbar indicatorStyle="white">
              {children}
            </ScrollView>
          ) : (
            children
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A select box that opens a searchable list. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  title,
  allowNone,
}: {
  value: T | null;
  options: readonly { value: T; label: string; sub?: string }[];
  onChange: (v: T | null) => void;
  placeholder?: string;
  title: string;
  allowNone?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const current = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(s)) : options;
  }, [q, options]);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={title} style={styles.select}>
        <Text variant="body" color={current ? colors.text : colors.textDim} style={{ flex: 1 }} numberOfLines={1}>
          {current ? current.label : value === null && allowNone ? allowNone : placeholder}
        </Text>
        <ChevronDown color={colors.textDim} size={18} />
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title={title}>
        {options.length > 8 ? (
          <View style={{ marginVertical: 8 }}>
            <Input value={q} onChangeText={setQ} placeholder="Search" icon={<Search color={colors.textDim} size={16} />} autoCorrect={false} />
          </View>
        ) : null}
        <FlatList
          style={{ maxHeight: 380 }}
          keyboardShouldPersistTaps="handled"
          data={allowNone ? [{ value: null as T | null, label: allowNone }, ...filtered] : filtered}
          keyExtractor={(o) => String(o.value)}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => {
                onChange(item.value);
                setOpen(false);
                setQ('');
              }}
              accessibilityRole="button"
              style={styles.option}
            >
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong">{item.label}</Text>
                {'sub' in item && item.sub ? <Text variant="small">{item.sub}</Text> : null}
              </View>
              {item.value === value ? <Check color={colors.cyan} size={18} /> : null}
            </Pressable>
          )}
          ListEmptyComponent={<Text variant="small">Nothing matches.</Text>}
        />
      </Sheet>
    </>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
export function fromMinutes(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** "14:05" → "2:05 PM". */
export function hm12(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * Time input: type it ("10:30", "1030", "2:05 pm"), pick AM / PM, or nudge by 5 minutes.
 * Value stays "HH:MM" (24-hour).
 */
export function TimeField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const min = toMinutes(value);
  const h24 = Math.floor(min / 60);
  const pm = h24 >= 12;
  const shown = `${h24 % 12 === 0 ? 12 : h24 % 12}:${value.slice(3)}`;
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  const commit = (raw = text) => {
    const v = parseTime(raw, pm);
    setBad(!v);
    if (v) {
      setText(`${Math.floor(toMinutes(v) / 60) % 12 === 0 ? 12 : Math.floor(toMinutes(v) / 60) % 12}:${v.slice(3)}`);
      if (v !== value) onChange(v);
    }
  };
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.timeRow}>
        <View style={[styles.timeBox, focused && { borderColor: colors.text }, bad && { borderColor: colors.red }]}>
          <TextInput
            value={text}
            onChangeText={(v) => {
              setText(v);
              setBad(false);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              commit();
            }}
            onSubmitEditing={() => commit()}
            keyboardType="numbers-and-punctuation"
            returnKeyType="done"
            selectTextOnFocus
            maxLength={8}
            accessibilityLabel={`${label}: type a time like 10:30`}
            placeholder="10:30"
            placeholderTextColor={colors.textDim}
            style={styles.timeInput}
          />
        </View>
        <View style={styles.ampm} accessibilityRole="radiogroup" accessibilityLabel={`${label} AM or PM`}>
          {(['AM', 'PM'] as const).map((p) => {
            const on = (p === 'PM') === pm;
            return (
              <Pressable
                key={p}
                onPress={() => !on && onChange(fromMinutes(min + (p === 'PM' ? 720 : -720)))}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={[styles.ampmBtn, on && styles.ampmOn]}
              >
                <Text style={[styles.ampmText, on && { color: colors.bg }]}>{p}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Pressable onPress={() => onChange(fromMinutes(min % 5 ? min - (min % 5) : min - 5))} style={styles.nudge} accessibilityRole="button" accessibilityLabel={`${label} 5 minutes earlier`} hitSlop={4}>
            <Minus color={colors.text} size={15} />
          </Pressable>
          <Pressable onPress={() => onChange(fromMinutes(min - (min % 5) + 5))} style={styles.nudge} accessibilityRole="button" accessibilityLabel={`${label} 5 minutes later`} hitSlop={4}>
            <Plus color={colors.text} size={15} />
          </Pressable>
        </View>
      </View>
      {bad ? (
        <Text variant="small" color={colors.red}>
          Type a time like 10:30, 1030 or 2:05 pm.
        </Text>
      ) : null}
    </View>
  );
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function addDays(ymdStr: string, days: number): string {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  return ymd(dt);
}
export function prettyDate(ymdStr: string): string {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Date: tap it to type (e.g. 27/09/2026), or step a day / a week. Always a valid calendar date. */
export function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const [y, m, d] = value.split('-');
  const start = () => {
    setText(`${d}/${m}/${y}`);
    setBad(false);
    setEditing(true);
  };
  const commit = () => {
    const v = parseDate(text, Number(y));
    if (!v) return setBad(true);
    setEditing(false);
    if (v !== value) onChange(v);
  };
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.dateRow}>
        <Pressable onPress={() => onChange(addDays(value, -7))} style={styles.dateBtn} accessibilityRole="button" accessibilityLabel="One week earlier">
          <Text variant="monoSmall">−7</Text>
        </Pressable>
        <Pressable onPress={() => onChange(addDays(value, -1))} style={styles.dateBtn} accessibilityRole="button" accessibilityLabel="One day earlier">
          <Minus color={colors.text} size={14} />
        </Pressable>
        {editing ? (
          <TextInput
            value={text}
            onChangeText={(v) => {
              setText(v);
              setBad(false);
            }}
            onBlur={commit}
            onSubmitEditing={commit}
            autoFocus
            selectTextOnFocus
            keyboardType="numbers-and-punctuation"
            returnKeyType="done"
            maxLength={10}
            accessibilityLabel="Date, for example 27/09/2026"
            style={[styles.dateInput, bad && { borderColor: colors.red }]}
          />
        ) : (
          <Pressable onPress={start} style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel={`${prettyDate(value)}. Tap to type a date`}>
            <Text variant="bodyStrong" style={{ textAlign: 'center' }}>
              {prettyDate(value)}
            </Text>
            <Text variant="small" style={{ textAlign: 'center', fontSize: 11 }}>
              tap to type
            </Text>
          </Pressable>
        )}
        <Pressable onPress={() => onChange(addDays(value, 1))} style={styles.dateBtn} accessibilityRole="button" accessibilityLabel="One day later">
          <Plus color={colors.text} size={14} />
        </Pressable>
        <Pressable onPress={() => onChange(addDays(value, 7))} style={styles.dateBtn} accessibilityRole="button" accessibilityLabel="One week later">
          <Text variant="monoSmall">+7</Text>
        </Pressable>
      </View>
      {bad ? (
        <Text variant="small" color={colors.red}>
          Type a date like 27/09/2026.
        </Text>
      ) : null}
    </View>
  );
}

/** Quick picks for the geofence; any value from 10 to 1000 m can be typed. */
export const RADIUS_PICKS = [15, 20, 30, 50, 75, 100] as const;

/** Allowed distance from the classroom centre: quick picks or a typed value (e.g. 20 m). */
export function RadiusField({ value, onChange }: { value: number; onChange: (m: number) => void }) {
  const custom = !(RADIUS_PICKS as readonly number[]).includes(value);
  const [text, setText] = useState(custom ? String(value) : '');
  const [bad, setBad] = useState(false);
  // Applied as it is typed (not only on leaving the box): tapping Save right after typing keeps it.
  const apply = (t: string) => {
    if (!t.trim()) return setBad(false);
    const n = Number(t);
    if (!Number.isInteger(n) || n < 10 || n > 1000) return setBad(true);
    setBad(false);
    onChange(n);
  };
  const commit = () => apply(text);
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.radiusRow}>
        {RADIUS_PICKS.map((m) => {
          const on = value === m;
          return (
            <Pressable
              key={m}
              onPress={() => {
                setText('');
                setBad(false);
                onChange(m);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              style={[styles.radiusChip, on && styles.ampmOn]}
            >
              <Text style={[styles.ampmText, on && { color: colors.bg }]}>{`${m} m`}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.radiusRow}>
        <View style={[styles.timeBox, { width: undefined, flex: 1 }, custom && { borderColor: colors.text }, bad && { borderColor: colors.red }]}>
          <TextInput
            value={text}
            onChangeText={(v) => {
              const t = v.replace(/[^0-9]/g, '').slice(0, 4);
              setText(t);
              // Short values (e.g. "2" on the way to "25") aren't errors yet; they apply once valid.
              if (t.length >= 2) apply(t);
              else setBad(false);
            }}
            onBlur={commit}
            onSubmitEditing={commit}
            keyboardType="number-pad"
            returnKeyType="done"
            placeholder="Custom, e.g. 20"
            placeholderTextColor={colors.textDim}
            accessibilityLabel="Custom distance in metres"
            style={[styles.timeInput, { fontSize: 17, textAlign: 'left' }]}
          />
        </View>
        <Text variant="bodyStrong">metres</Text>
      </View>
      <Text variant="small" color={bad ? colors.red : undefined}>
        {bad ? 'Enter a distance from 10 to 1000 metres.' : `Students must be within ${value} m of the classroom centre (plus a few metres for GPS drift).`}
      </Text>
    </View>
  );
}

export const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
] as const;
export const WEEKDAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The first message of a validation error, readable. */
export function firstIssue(err: unknown): string {
  const issues = (err as { issues?: { message: string; path?: PropertyKey[] }[] })?.issues;
  if (Array.isArray(issues) && issues[0]) return issues[0].message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4, marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  chipOn: { borderColor: 'rgba(255, 255, 255, 0.55)', backgroundColor: 'rgba(255, 255, 255, 0.10)' },
  chipText: { fontFamily: fonts.medium, fontSize: 13.5, color: colors.textMuted },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  box: { borderRadius: 7, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, borderRadius: radius.lg },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, padding: 20, paddingBottom: 36, maxHeight: '88%' },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderHi, marginBottom: 14 },
  select: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 52, paddingHorizontal: 16, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: { width: 40, height: 40, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgRaised },
  stepVal: { fontFamily: fonts.monoMedium, fontSize: 20, color: colors.text, minWidth: 34, textAlign: 'center' },
  colon: { fontFamily: fonts.monoMedium, fontSize: 20, color: colors.textMuted },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  timeBox: { borderWidth: 1, borderColor: colors.borderHi, borderRadius: radius.md, backgroundColor: colors.bgRaised, width: 112 },
  timeInput: { fontFamily: fonts.monoMedium, fontSize: 22, color: colors.text, paddingVertical: 10, paddingHorizontal: 14, textAlign: 'center' },
  nudge: { width: 40, height: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  radiusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  radiusChip: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: colors.borderHi },
  dateInput: { flex: 1, fontFamily: fonts.monoMedium, fontSize: 17, color: colors.text, textAlign: 'center', paddingVertical: 8, borderWidth: 1, borderColor: colors.text, borderRadius: radius.sm },
  ampm: { flexDirection: 'row', borderRadius: 999, borderWidth: 1, borderColor: colors.border, padding: 3, gap: 2, marginLeft: 4 },
  ampmBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  ampmOn: { backgroundColor: colors.text },
  ampmText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textMuted },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 6, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised },
  dateBtn: { width: 38, height: 38, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
});
