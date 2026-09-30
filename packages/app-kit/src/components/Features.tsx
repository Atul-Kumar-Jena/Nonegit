import { useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { ChevronRight, Info, X } from 'lucide-react-native';
import { colors, fonts, radius } from '../theme';
import { Button, Edge, SectionLabel, Text } from './ui';

export interface Feature {
  icon: ReactNode;
  label: string;
  href: Href;
  badge?: string | null;
}

/** Every option in one box: a calm grid of tiles, three per row. */
export function FeatureGrid({ items }: { items: Feature[] }) {
  return (
    <View style={styles.grid}>
      {items.map((f) => (
        <Pressable
          key={f.label}
          onPress={() => router.push(f.href)}
          accessibilityRole="button"
          accessibilityLabel={f.badge ? `${f.label}, ${f.badge}` : f.label}
          style={({ pressed }) => [styles.tile, pressed && { backgroundColor: colors.cardHi }]}
        >
          <View style={styles.icon}>{f.icon}</View>
          <Text variant="small" color={colors.text} style={styles.label} numberOfLines={2}>
            {f.label}
          </Text>
          {f.badge ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{f.badge}</Text>
            </View>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

/** Two to four big, equal shortcut tiles in a row — for a screen's most-used jumps. */
export function ActionTiles({ items }: { items: { icon: ReactNode; label: string; onPress: () => void }[] }) {
  return (
    <View style={styles.tiles}>
      {items.map((a) => (
        <Pressable
          key={a.label}
          onPress={a.onPress}
          accessibilityRole="button"
          accessibilityLabel={a.label}
          style={({ pressed }) => [styles.tile2, pressed && { backgroundColor: colors.border, transform: [{ scale: 0.98 }] }]}
        >
          <Edge />
          <View style={styles.rowIcon}>{a.icon}</View>
          <Text variant="small" color={colors.text} style={styles.tileLabel} numberOfLines={2}>
            {a.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A titled group of one-line rows — calmer than a grid when there are many options. */
export function FeatureList({ title, items }: { title: string; items: Feature[] }) {
  if (!items.length) return null;
  return (
    <>
      <SectionLabel>{title}</SectionLabel>
      <View style={styles.list}>
        <Edge />
        {items.map((f, n) => (
          <Pressable
            key={f.label}
            onPress={() => router.push(f.href)}
            accessibilityRole="button"
            accessibilityLabel={f.badge ? `${f.label}, ${f.badge}` : f.label}
            style={({ pressed }) => [styles.item, n < items.length - 1 && styles.itemLine, pressed && { backgroundColor: colors.cardHi }]}
          >
            <View style={styles.rowIcon}>{f.icon}</View>
            <Text variant="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>
              {f.label}
            </Text>
            {f.badge ? (
              <View style={[styles.badge, { position: 'relative', top: 0, right: 0 }]}>
                <Text style={styles.badgeText}>{f.badge}</Text>
              </View>
            ) : null}
            <ChevronRight color={colors.textDim} size={16} />
          </Pressable>
        ))}
      </View>
    </>
  );
}

/** The "i" button: a short, plain explanation of the screen or feature. */
export function InfoButton({ title, text }: { title: string; text: string | string[] }) {
  const [open, setOpen] = useState(false);
  const lines = Array.isArray(text) ? text : [text];
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`About ${title}`} hitSlop={10} style={styles.info}>
        <Info color={colors.textMuted} size={17} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.scrim} onPress={() => setOpen(false)} accessibilityLabel="Close" />
        <View style={styles.sheetWrap} pointerEvents="box-none">
          <View style={styles.sheet}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <Text variant="heading" style={{ flex: 1 }}>
                {title}
              </Text>
              <Pressable onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10}>
                <X color={colors.textMuted} size={20} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 420 }}>
              {lines.map((l, i) => (
                <Text key={i} variant="body" color={colors.text} style={{ marginBottom: 10 }}>
                  {l}
                </Text>
              ))}
            </ScrollView>
            <Button title="Got it" kind="secondary" compact onPress={() => setOpen(false)} style={{ marginTop: 6 }} />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.card },
  tile: { width: '33.333%', minHeight: 96, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 10, borderColor: colors.border, borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  tiles: { flexDirection: 'row', gap: 10, marginTop: 14 },
  tile2: { flex: 1, minHeight: 86, padding: 12, gap: 10, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, overflow: 'hidden', justifyContent: 'space-between' },
  tileLabel: { fontFamily: fonts.semibold, fontSize: 13 },
  list: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.card },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 12 },
  rowIcon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  itemLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)' },
  label: { textAlign: 'center', fontFamily: fonts.medium, fontSize: 12.5 },
  badge: { position: 'absolute', top: 10, right: 12, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: colors.amber, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: fonts.bold, fontSize: 11, color: colors.bg },
  info: { width: 34, height: 34, borderRadius: 12, borderWidth: 1, borderColor: colors.borderHi, backgroundColor: colors.cardHi, alignItems: 'center', justifyContent: 'center' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)' },
  sheetWrap: { flex: 1, justifyContent: 'center', padding: 20 },
  sheet: { backgroundColor: colors.card, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, padding: 20 },
});
