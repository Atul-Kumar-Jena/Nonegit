/**
 * Small, dependency-free charts (react-native-svg) in the app's monochrome style. Colour is used
 * only for state against the minimum attendance: at/above = light ink, below = amber, far below =
 * red — always with a text value too, never colour alone. Tap a bar to read its exact value.
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { Text } from './ui';
import { colors, fonts } from '../theme';

export interface Point {
  key: string;
  /** Short axis label, e.g. "12" or "Mon". */
  label: string;
  /** 0–100, or null for "no classes". */
  value: number | null;
  /** Shown when tapped, e.g. "Tue 12 Sep · 3 classes · 41 of 50". */
  detail?: string;
}

const ink = 'rgba(255,255,255,0.86)';
const grid = 'rgba(255,255,255,0.08)';

export function stateColor(v: number | null, min: number): string {
  if (v === null) return colors.textDim;
  if (v >= min) return ink;
  if (v >= min - 15) return colors.amber;
  return colors.red;
}

function useWidth(initial = 300) {
  const [w, setW] = useState(initial);
  return { w, onLayout: (e: LayoutChangeEvent) => setW(Math.max(120, Math.round(e.nativeEvent.layout.width))) };
}

/** Vertical bars over time with the minimum as a dashed line. */
export function TrendBars({ data, min, height = 150, title }: { data: Point[]; min: number; height?: number; title?: string }) {
  const { w, onLayout } = useWidth();
  const [sel, setSel] = useState<number | null>(null);
  const padL = 30;
  const padB = 18;
  const plotW = w - padL;
  const plotH = height - padB - 6;
  const n = Math.max(1, data.length);
  const slot = plotW / n;
  const bw = Math.max(3, Math.min(22, slot - 2));
  const y = (v: number) => 6 + plotH - (v / 100) * plotH;
  const labelEvery = Math.ceil(n / 7);
  const shown = sel !== null ? data[sel] : data.filter((d) => d.value !== null).at(-1);
  return (
    <View onLayout={onLayout} style={{ gap: 6 }}>
      <View style={styles.readout}>
        <Text variant="small" style={{ flex: 1 }} numberOfLines={2}>
          {shown ? (shown.detail ?? shown.label) : title ?? 'No classes in this period yet'}
        </Text>
        {shown?.value !== undefined && shown?.value !== null ? <Text style={[styles.readVal, { color: shown.value < min ? stateColor(shown.value, min) : colors.text }]}>{`${Math.round(shown.value)}%`}</Text> : null}
      </View>
      <Svg width={w} height={height}>
        {[0, 50, 100].map((g) => (
          <Line key={g} x1={padL} x2={w} y1={y(g)} y2={y(g)} stroke={grid} strokeWidth={1} />
        ))}
        {[0, 50, 100].map((g) => (
          <SvgText key={`t${g}`} x={padL - 6} y={y(g) + 4} fontSize={10} fill={colors.textDim} textAnchor="end" fontFamily={fonts.mono}>
            {`${g}`}
          </SvgText>
        ))}
        {data.map((d, i) => {
          const x = padL + i * slot + (slot - bw) / 2;
          const v = d.value;
          const top = v === null ? y(0) - 2 : y(Math.max(v, 1.5));
          const h = y(0) - top;
          const r = Math.min(4, bw / 2, h);
          const path = `M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${y(0)} Z`;
          return <Path key={d.key} d={path} fill={v === null ? grid : stateColor(v, min)} opacity={sel === null || sel === i ? 1 : 0.45} />;
        })}
        <Line x1={padL} x2={w} y1={y(min)} y2={y(min)} stroke={colors.amber} strokeWidth={1.2} strokeDasharray="4 4" />
        <SvgText x={w - 2} y={y(min) - 4} fontSize={10} fill={colors.amber} textAnchor="end" fontFamily={fonts.mono}>{`min ${min}%`}</SvgText>
        {data.map((d, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <SvgText key={`l${d.key}`} x={padL + i * slot + slot / 2} y={height - 4} fontSize={10} fill={colors.textDim} textAnchor="middle" fontFamily={fonts.mono}>
              {d.label}
            </SvgText>
          ) : null,
        )}
      </Svg>
      {/* Touch targets wider than the bars. */}
      <View style={[StyleSheet.absoluteFill, { top: 40, left: padL, flexDirection: 'row' }]}>
        {data.map((d, i) => (
          <Pressable key={d.key} style={{ width: slot, height: height }} onPress={() => setSel(sel === i ? null : i)} accessibilityRole="button" accessibilityLabel={`${d.detail ?? d.label}: ${d.value === null ? 'no classes' : `${Math.round(d.value)} percent`}`} />
        ))}
      </View>
    </View>
  );
}

/** A tiny trend line for summary cards (no axes). */
export function Sparkline({ values, min, height = 36, width = 120 }: { values: (number | null)[]; min: number; height?: number; width?: number }) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v !== null);
  if (pts.length < 2) return <View style={{ width, height }} />;
  const x = (i: number) => (i / Math.max(1, values.length - 1)) * (width - 6) + 3;
  const y = (v: number) => 3 + (height - 6) * (1 - v / 100);
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts.at(-1)!;
  return (
    <Svg width={width} height={height}>
      <Line x1={0} x2={width} y1={y(min)} y2={y(min)} stroke={colors.amber} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
      <Path d={d} stroke={ink} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <Rect x={x(last.i) - 4} y={y(last.v) - 4} width={8} height={8} rx={4} fill={stateColor(last.v, min)} stroke={colors.card} strokeWidth={2} />
    </Svg>
  );
}

/** One horizontal bar per row (subjects, batches, professors) with its value and the minimum marker. */
export function HBars({ rows, min, suffix = '%', onPress }: { rows: { key: string; label: string; sub?: string; value: number | null }[]; min: number; suffix?: string; onPress?: (key: string) => void }) {
  const { w, onLayout } = useWidth();
  const track = Math.max(60, w * 0.48);
  return (
    <View onLayout={onLayout} style={{ gap: 10 }}>
      {rows.map((r) => {
        const v = r.value;
        const fill = v === null ? 0 : Math.max(2, (Math.min(100, v) / 100) * track);
        const Row = onPress ? Pressable : View;
        return (
          <Row key={r.key} {...(onPress ? { onPress: () => onPress(r.key), accessibilityRole: 'button' as const } : {})} style={styles.hrow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="bodyStrong" numberOfLines={1} style={{ fontSize: 14 }}>
                {r.label}
              </Text>
              {r.sub ? (
                <Text variant="small" numberOfLines={1}>
                  {r.sub}
                </Text>
              ) : null}
            </View>
            <Svg width={track} height={14}>
              <Rect x={0} y={3} width={track} height={8} rx={4} fill={grid} />
              <Rect x={0} y={3} width={fill} height={8} rx={4} fill={stateColor(v, min)} />
              <Line x1={(min / 100) * track} x2={(min / 100) * track} y1={0} y2={14} stroke={colors.amber} strokeWidth={1.5} />
            </Svg>
            <Text style={[styles.hval, { color: v !== null && v < min ? stateColor(v, min) : colors.text }]}>{v === null ? '—' : `${Math.round(v)}${suffix}`}</Text>
          </Row>
        );
      })}
    </View>
  );
}

/** Students spread around the minimum: one stacked bar + a labelled legend (counts in text). */
export function BandBar({ bands, min }: { bands: { safe: number; near: number; below: number; far: number }; min: number }) {
  const { w, onLayout } = useWidth();
  const total = bands.safe + bands.near + bands.below + bands.far;
  const parts = useMemo(
    () => [
      { key: 'safe', label: `${min + 10}%+`, n: bands.safe, color: ink },
      { key: 'near', label: `${min}–${min + 10}%`, n: bands.near, color: 'rgba(255,255,255,0.45)' },
      { key: 'below', label: `${min - 15}–${min}%`, n: bands.below, color: colors.amber },
      { key: 'far', label: `under ${min - 15}%`, n: bands.far, color: colors.red },
    ],
    [bands, min],
  );
  let x = 0;
  return (
    <View onLayout={onLayout} style={{ gap: 10 }}>
      <Svg width={w} height={16}>
        {total === 0 ? <Rect x={0} y={2} width={w} height={12} rx={6} fill={grid} /> : null}
        {parts.map((p) => {
          if (!p.n) return null;
          const pw = (p.n / total) * w;
          const r = <Rect key={p.key} x={x + 1} y={2} width={Math.max(2, pw - 2)} height={12} rx={4} fill={p.color} />;
          x += pw;
          return r;
        })}
      </Svg>
      <View style={styles.legend}>
        {parts.map((p) => (
          <View key={p.key} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: p.color }]} />
            <Text variant="small">{`${p.label} · ${p.n}`}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Groups daily points into weeks when there are too many days to show one bar each. */
export function weekly<T extends { date: string; present: number; expected: number }>(days: T[]): { key: string; date: string; present: number; expected: number; days: number }[] {
  const out = new Map<string, { key: string; date: string; present: number; expected: number; days: number }>();
  for (const d of days) {
    const dt = new Date(`${d.date}T00:00:00Z`);
    const monday = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const w = out.get(monday) ?? { key: monday, date: monday, present: 0, expected: 0, days: 0 };
    w.present += d.present;
    w.expected += d.expected;
    w.days++;
    out.set(monday, w);
  }
  return [...out.values()];
}

const styles = StyleSheet.create({
  readout: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 34 },
  readVal: { fontFamily: fonts.display, fontSize: 22, letterSpacing: -0.3 },
  hrow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hval: { fontFamily: fonts.semibold, fontSize: 14, width: 44, textAlign: 'right' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
});
