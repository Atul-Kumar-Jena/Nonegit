import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanResponder, ScrollView, StyleSheet, View, useWindowDimensions, type LayoutRectangle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { ArrowRightLeft, ClipboardList, Lock, UserRound } from 'lucide-react-native';
import { hmToMin, minToHm, weekdayOf, type PlannerCourse, type PlannerItem } from '@attendly/protocol';
import { Text } from '@kit/components/ui';
import { layoutDay } from './layout';
import { colors, fonts } from '@kit/theme';

export const SNAP_MIN = 5;
const HEADER_H = 44;
const GUTTER = 38;
const LONG_PRESS_MS = 230;
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HUES = [190, 265, 150, 25, 330, 45, 210, 290, 120, 0];

export function courseColor(courseId: string): { bg: string; line: string } {
  let h = 0;
  for (let i = 0; i < courseId.length; i++) h = (h * 31 + courseId.charCodeAt(i)) >>> 0;
  const hue = HUES[h % HUES.length]!;
  return { bg: `hsla(${hue}, 70%, 45%, 0.24)`, line: `hsla(${hue}, 80%, 62%, 0.9)` };
}

export type DropTarget = { date: string; startMin: number; overKey: string | null };
type Box = { w: number; h: number; fx: number; fy: number };
interface DragHandlers {
  start: (src: DragSource, x: number, y: number, box: Box) => void;
  move: (x: number, y: number) => void;
  end: (x: number, y: number) => void;
  cancel: () => void;
}
export type DragSource = { kind: 'item'; item: PlannerItem } | { kind: 'course'; course: PlannerCourse };

interface Geometry {
  days: string[];
  colW: number;
  ppm: number;
  dayStart: number;
  dayEnd: number;
}

/**
 * Long-press to pick up, drag, release to drop. A quick tap opens the class.
 * Movement before the long-press lets the surrounding list scroll normally.
 */
function useDrag(opts: { disabled: boolean; onTap: () => void; onStart: (x: number, y: number) => void; onMove: (x: number, y: number) => void; onEnd: (x: number, y: number) => void; onCancel: () => void }) {
  const ref = useRef(opts);
  ref.current = opts;
  const state = useRef({ active: false, cancelled: false, t0: 0, timer: null as ReturnType<typeof setTimeout> | null, x: 0, y: 0 });
  return useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !ref.current.disabled,
        onPanResponderGrant: (e) => {
          const s = state.current;
          s.active = false;
          s.cancelled = false;
          s.t0 = Date.now();
          s.x = e.nativeEvent.pageX;
          s.y = e.nativeEvent.pageY;
          s.timer = setTimeout(() => {
            if (s.cancelled) return;
            s.active = true;
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
            ref.current.onStart(s.x, s.y);
          }, LONG_PRESS_MS);
        },
        onPanResponderMove: (e) => {
          const s = state.current;
          const { pageX, pageY } = e.nativeEvent;
          if (s.active) ref.current.onMove(pageX, pageY);
          else if (Math.abs(pageX - s.x) > 8 || Math.abs(pageY - s.y) > 8) {
            s.cancelled = true;
            if (s.timer) clearTimeout(s.timer);
          }
        },
        onPanResponderRelease: (e) => {
          const s = state.current;
          if (s.timer) clearTimeout(s.timer);
          if (s.active) ref.current.onEnd(e.nativeEvent.pageX, e.nativeEvent.pageY);
          else if (!s.cancelled && Date.now() - s.t0 < LONG_PRESS_MS + 400) ref.current.onTap();
          s.active = false;
        },
        onPanResponderTerminationRequest: () => !state.current.active,
        onPanResponderTerminate: () => {
          const s = state.current;
          if (s.timer) clearTimeout(s.timer);
          if (s.active) ref.current.onCancel();
          s.active = false;
          s.cancelled = true;
        },
      }),
    [],
  );
}

const Card = memo(function Card({
  item,
  course,
  room,
  teacher,
  geom,
  pos,
  conflict,
  dragging,
  onTap,
  drag,
}: {
  item: PlannerItem;
  course: PlannerCourse | undefined;
  room: string | undefined;
  teacher: string | undefined;
  geom: Geometry;
  pos: { lane: number; lanes: number };
  conflict: 'error' | 'warning' | undefined;
  dragging: boolean;
  onTap: (item: PlannerItem) => void;
  drag: DragHandlers;
}) {
  const day = geom.days.indexOf(item.date);
  const top = (hmToMin(item.start) - geom.dayStart) * geom.ppm;
  const h = Math.max(22, (hmToMin(item.end) - hmToMin(item.start)) * geom.ppm - 2);
  const w = (geom.colW - 4) / pos.lanes;
  const left = GUTTER + day * geom.colW + 2 + pos.lane * w;
  const color = courseColor(item.courseId);
  const cancelled = item.status === 'cancelled';
  const movable = !item.locked && !cancelled;
  const handlers = useDrag({
    disabled: false,
    onTap: () => onTap(item),
    onStart: (x, y) => (movable ? drag.start({ kind: 'item', item }, x, y, { w, h, fx: 0, fy: 0 }) : onTap(item)),
    onMove: (x, y) => movable && drag.move(x, y),
    onEnd: (x, y) => movable && drag.end(x, y),
    onCancel: () => drag.cancel(),
  });
  if (day < 0) return null;
  const compact = w < 70;
  return (
    <View
      {...handlers.panHandlers}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${course?.code ?? 'Class'} ${item.start} to ${item.end}${room ? `, ${room}` : ''}${cancelled ? ', cancelled' : ''}${item.pending.length ? ', changed in this draft' : ''}${conflict ? `, ${conflict === 'error' ? 'clash' : 'warning'}` : ''}. Tap to edit, long-press to drag.`}
      style={[
        styles.card,
        {
          left,
          top,
          width: w - 2,
          height: h,
          backgroundColor: color.bg,
          borderLeftColor: color.line,
          opacity: dragging ? 0.25 : cancelled ? 0.45 : 1,
          borderColor: conflict === 'error' ? colors.red : conflict === 'warning' ? colors.amber : item.pending.length ? colors.violet : 'transparent',
          borderWidth: conflict || item.pending.length ? 2 : 0,
          borderLeftWidth: 4,
        },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
        <Text style={[styles.code, cancelled && { textDecorationLine: 'line-through' }]} numberOfLines={1}>
          {course?.code ?? '—'}
        </Text>
        {item.locked ? <Lock color={colors.textDim} size={9} /> : null}
        {item.mode === 'manual' ? <ClipboardList color={colors.textMuted} size={9} /> : null}
        {item.substitute ? <UserRound color={colors.violet} size={9} /> : null}
        {item.pending.includes('reschedule') || item.pending.includes('weekly') ? <ArrowRightLeft color={colors.violet} size={9} /> : null}
      </View>
      {h > 30 ? (
        <Text style={styles.meta} numberOfLines={1}>
          {item.start}
          {compact ? '' : `–${item.end}`}
        </Text>
      ) : null}
      {h > 46 && !compact ? (
        <Text style={styles.meta} numberOfLines={1}>
          {[room, teacher].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
    </View>
  );
});

function TrayChip({ course, drag, onTap }: { course: PlannerCourse; drag: DragHandlers; onTap: (c: PlannerCourse) => void }) {
  const color = courseColor(course.id);
  const handlers = useDrag({
    disabled: false,
    onTap: () => onTap(course),
    onStart: (x, y) => drag.start({ kind: 'course', course }, x, y, { w: 90, h: 44, fx: 45, fy: 22 }),
    onMove: (x, y) => drag.move(x, y),
    onEnd: (x, y) => drag.end(x, y),
    onCancel: () => drag.cancel(),
  });
  return (
    <View {...handlers.panHandlers} accessible accessibilityRole="button" accessibilityLabel={`${course.code}: tap to add a class, or long-press and drag it onto the timetable`} style={[styles.chip, { backgroundColor: color.bg, borderColor: color.line }]}>
      <Text style={styles.code}>{course.code}</Text>
      <Text style={styles.meta} numberOfLines={1}>
        {course.instructorName ?? 'no teacher'}
      </Text>
    </View>
  );
}

export interface BoardProps {
  days: string[];
  items: PlannerItem[];
  courses: Map<string, PlannerCourse>;
  rooms: Map<string, string>;
  teachers: Map<string, string>;
  conflicts: Map<string, 'error' | 'warning'>;
  tray: PlannerCourse[];
  compact: boolean;
  today: string;
  onTap: (item: PlannerItem) => void;
  onTrayTap: (course: PlannerCourse) => void;
  onDrop: (src: DragSource, target: DropTarget) => void;
  header?: ReactNode;
}

/**
 * The week grid. Classes can be long-pressed and dragged to any day/time (or
 * onto another class to swap), and courses dragged in from the tray below.
 */
export function Board(p: BoardProps) {
  const { width: winW } = useWindowDimensions();
  const [viewport, setViewport] = useState<LayoutRectangle | null>(null);
  const vpW = viewport?.width ?? winW;
  const vpH = viewport?.height ?? 500;

  // Hours shown: at least 08:00–18:00, stretched to fit every class.
  const { dayStart, dayEnd } = useMemo(() => {
    let s = 8 * 60;
    let e = 18 * 60;
    for (const it of p.items) {
      s = Math.min(s, Math.floor(hmToMin(it.start) / 60) * 60);
      e = Math.max(e, Math.ceil(hmToMin(it.end) / 60) * 60);
    }
    return { dayStart: Math.max(0, s), dayEnd: Math.min(24 * 60, e) };
  }, [p.items]);
  const colW = p.compact ? Math.max(48, (vpW - GUTTER - 2) / p.days.length) : 136;
  const ppm = (p.compact ? 56 : 72) / 60;
  const geom: Geometry = { days: p.days, colW, ppm, dayStart, dayEnd };
  const gridW = GUTTER + colW * p.days.length;
  const gridH = (dayEnd - dayStart) * ppm;

  const byDay = useMemo(() => {
    const m = new Map<string, Map<string, { lane: number; lanes: number }>>();
    for (const d of p.days) m.set(d, layoutDay(p.items.filter((i) => i.date === d)));
    return m;
  }, [p.items, p.days]);

  // ── drag state ──
  const rootRef = useRef<View>(null);
  const hRef = useRef<ScrollView>(null);
  const vRef = useRef<ScrollView>(null);
  const scroll = useRef({ x: 0, y: 0 });
  const origin = useRef({ root: { x: 0, y: 0 }, grid: { x: 0, y: 0 } });
  const pointer = useRef({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ src: DragSource; box: { w: number; h: number; fx: number; fy: number }; x: number; y: number; target: DropTarget | null } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const measure = useCallback(
    () =>
      new Promise<void>((resolve) => {
        rootRef.current?.measureInWindow((rx, ry) => {
          origin.current.root = { x: rx, y: ry };
          // The grid's viewport starts below the day headers.
          origin.current.grid = { x: rx, y: ry + HEADER_H };
          resolve();
        });
      }),
    [],
  );

  const targetAt = useCallback(
    (x: number, y: number, box: { w: number; h: number; fx: number; fy: number }, src: DragSource): DropTarget | null => {
      const gx = x - origin.current.grid.x + scroll.current.x - GUTTER;
      const gy = y - origin.current.grid.y + scroll.current.y;
      const dayIdx = Math.floor(gx / colW);
      if (dayIdx < 0 || dayIdx >= p.days.length || gy < -20 || gy > gridH + 20) return null;
      const topY = gy - box.fy;
      let startMin = dayStart + topY / ppm;
      startMin = Math.round(startMin / SNAP_MIN) * SNAP_MIN;
      const dur = src.kind === 'item' ? hmToMin(src.item.end) - hmToMin(src.item.start) : 60;
      startMin = Math.max(0, Math.min(24 * 60 - dur, startMin));
      const date = p.days[dayIdx]!;
      const pointerMin = dayStart + gy / ppm;
      const over = p.items.find(
        (i) => i.date === date && (src.kind !== 'item' || i.key !== src.item.key) && hmToMin(i.start) <= pointerMin && pointerMin < hmToMin(i.end) && i.status !== 'cancelled' && !i.locked,
      );
      return { date, startMin, overKey: over?.key ?? null };
    },
    [colW, p.days, p.items, gridH, dayStart, ppm],
  );

  // Auto-scroll while holding near an edge.
  useEffect(() => {
    if (!drag) return;
    const t = setInterval(() => {
      const d = dragRef.current;
      if (!d) return;
      const { x, y } = pointer.current;
      const gx0 = origin.current.grid.x;
      const gy0 = origin.current.grid.y;
      let dx = 0;
      let dy = 0;
      if (gridW > vpW + 1) {
        if (x < gx0 + 36) dx = -14;
        else if (x > gx0 + vpW - 36) dx = 14;
      }
      if (y < gy0 + 30) dy = -14;
      else if (y > gy0 + (vpH - HEADER_H) - 30) dy = 14;
      if (!dx && !dy) return;
      const nx = Math.max(0, Math.min(gridW - vpW, scroll.current.x + dx));
      const ny = Math.max(0, Math.min(gridH - (vpH - HEADER_H), scroll.current.y + dy));
      if (nx !== scroll.current.x) hRef.current?.scrollTo({ x: nx, animated: false });
      if (ny !== scroll.current.y) vRef.current?.scrollTo({ y: ny, animated: false });
      scroll.current = { x: nx, y: ny };
      setDrag((cur) => (cur ? { ...cur, target: targetAt(x, y, cur.box, cur.src) } : cur));
    }, 40);
    return () => clearInterval(t);
  }, [drag !== null, gridW, gridH, vpW, vpH, targetAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlers = useMemo(
    () => ({
      start: (src: DragSource, x: number, y: number, box: { w: number; h: number; fx: number; fy: number }) => {
        void measure().then(() => {
          // For a class, keep the finger where it grabbed the card.
          let b = box;
          if (src.kind === 'item') {
            const pos = byDay.get(src.item.date)?.get(src.item.key) ?? { lane: 0, lanes: 1 };
            const w = (colW - 4) / pos.lanes;
            const cardLeft = origin.current.grid.x - scroll.current.x + GUTTER + p.days.indexOf(src.item.date) * colW + 2 + pos.lane * w;
            const cardTop = origin.current.grid.y - scroll.current.y + (hmToMin(src.item.start) - dayStart) * ppm;
            b = { w: w - 2, h: Math.max(22, (hmToMin(src.item.end) - hmToMin(src.item.start)) * ppm - 2), fx: x - cardLeft, fy: y - cardTop };
          }
          pointer.current = { x, y };
          setDrag({ src, box: b, x, y, target: targetAt(x, y, b, src) });
        });
      },
      move: (x: number, y: number) => {
        pointer.current = { x, y };
        setDrag((cur) => (cur ? { ...cur, x, y, target: targetAt(x, y, cur.box, cur.src) } : cur));
      },
      end: (x: number, y: number) => {
        const cur = dragRef.current;
        setDrag(null);
        if (!cur) return;
        const t = targetAt(x, y, cur.box, cur.src);
        if (t) p.onDrop(cur.src, t);
      },
      cancel: () => setDrag(null),
    }),
    [measure, targetAt, byDay, colW, p, dayStart, ppm],
  );

  const hours: number[] = [];
  for (let m = Math.ceil(dayStart / 60) * 60; m <= dayEnd; m += 60) hours.push(m);
  const ghostCourse = drag ? (drag.src.kind === 'item' ? p.courses.get(drag.src.item.courseId) : drag.src.course) : undefined;
  const target = drag?.target;
  const targetDur = drag ? (drag.src.kind === 'item' ? hmToMin(drag.src.item.end) - hmToMin(drag.src.item.start) : 60) : 0;

  return (
    <View style={{ flex: 1 }}>
      <View ref={rootRef} style={{ flex: 1 }} onLayout={(e) => setViewport(e.nativeEvent.layout)} collapsable={false}>
        <ScrollView
          ref={hRef}
          horizontal
          scrollEnabled={!drag && gridW > vpW + 1}
          showsHorizontalScrollIndicator={false}
          onScroll={(e) => (scroll.current.x = e.nativeEvent.contentOffset.x)}
          scrollEventThrottle={16}
          contentContainerStyle={{ width: Math.max(gridW, vpW) }}
        >
          <View style={{ width: Math.max(gridW, vpW) }}>
            {/* day headers */}
            <View style={[styles.headerRow, { height: HEADER_H }]}>
              <View style={{ width: GUTTER }} />
              {p.days.map((d) => {
                const n = p.items.filter((i) => i.date === d && i.status !== 'cancelled').length;
                const isToday = d === p.today;
                return (
                  <View key={d} style={[styles.dayHead, { width: colW }, isToday && styles.today]}>
                    <Text style={[styles.dayName, isToday && { color: colors.cyan }]}>{DAY_SHORT[weekdayOf(d)]}</Text>
                    <Text style={styles.dayDate}>
                      {Number(d.slice(8))}
                      {p.compact ? '' : ` · ${n}`}
                    </Text>
                  </View>
                );
              })}
            </View>
            <ScrollView
              ref={vRef}
              style={{ height: Math.max(120, vpH - HEADER_H) }}
              scrollEnabled={!drag}
              onScroll={(e) => (scroll.current.y = e.nativeEvent.contentOffset.y)}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              <View style={{ width: gridW, height: gridH + 8 }}>
                {hours.map((m) => (
                  <View key={m} style={[styles.hourLine, { top: (m - dayStart) * ppm }]}>
                    <Text style={styles.hourText}>{minToHm(m).slice(0, 2)}</Text>
                  </View>
                ))}
                {p.days.map((d, i) => (
                  <View key={d} style={[styles.dayCol, { left: GUTTER + i * colW, width: colW, height: gridH }, d === p.today && { backgroundColor: 'rgba(34,211,238,0.035)' }, d < p.today && { backgroundColor: 'rgba(255,255,255,0.02)' }]} />
                ))}
                {target ? (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.dropPreview,
                      {
                        left: GUTTER + p.days.indexOf(target.date) * colW + 2,
                        top: (target.startMin - dayStart) * ppm,
                        width: colW - 4,
                        height: Math.max(22, targetDur * ppm - 2),
                        borderColor: target.overKey ? colors.amber : colors.cyan,
                      },
                    ]}
                  >
                    <Text style={styles.dropText}>
                      {target.overKey ? 'Swap' : `${minToHm(target.startMin)}`}
                    </Text>
                  </View>
                ) : null}
                {p.items.map((it) => (
                  <Card
                    key={it.key}
                    item={it}
                    course={p.courses.get(it.courseId)}
                    room={it.roomId ? p.rooms.get(it.roomId) : undefined}
                    teacher={it.teacherId ? p.teachers.get(it.teacherId) : undefined}
                    geom={geom}
                    pos={byDay.get(it.date)?.get(it.key) ?? { lane: 0, lanes: 1 }}
                    conflict={p.conflicts.get(it.key)}
                    dragging={drag?.src.kind === 'item' && drag.src.item.key === it.key}
                    onTap={p.onTap}
                    drag={handlers}
                  />
                ))}
              </View>
            </ScrollView>
          </View>
        </ScrollView>
      </View>

      {p.tray.length ? (
        <View style={styles.tray}>
          <Text variant="label" style={{ marginBottom: 6 }}>
            Add a class — tap, or hold & drag onto the week
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} scrollEnabled={!drag}>
            {p.tray.map((c) => (
              <TrayChip key={c.id} course={c} drag={handlers} onTap={p.onTrayTap} />
            ))}
          </ScrollView>
        </View>
      ) : null}

      {drag ? (
        <View
          pointerEvents="none"
          style={[
            styles.ghost,
            {
              left: drag.x - drag.box.fx - origin.current.root.x,
              top: drag.y - drag.box.fy - origin.current.root.y,
              width: Math.max(60, drag.box.w),
              height: Math.max(30, drag.box.h),
              backgroundColor: ghostCourse ? courseColor(ghostCourse.id).bg : colors.card,
              borderColor: ghostCourse ? courseColor(ghostCourse.id).line : colors.cyan,
            },
          ]}
        >
          <Text style={styles.code}>{ghostCourse?.code ?? ''}</Text>
          {target ? <Text style={styles.meta}>{`${DAY_SHORT[weekdayOf(target.date)]} ${minToHm(target.startMin)}`}</Text> : <Text style={styles.meta}>drop on the week</Text>}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.bg },
  dayHead: { alignItems: 'center', justifyContent: 'center', borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
  today: { backgroundColor: 'rgba(34,211,238,0.07)' },
  dayName: { fontFamily: fonts.semibold, fontSize: 12, color: colors.text },
  dayDate: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim },
  hourLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  hourText: { position: 'absolute', left: 6, top: -1, fontFamily: fonts.mono, fontSize: 10, color: colors.textDim },
  dayCol: { position: 'absolute', top: 0, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
  card: { position: 'absolute', borderRadius: 8, paddingHorizontal: 4, paddingVertical: 3, overflow: 'hidden' },
  code: { fontFamily: fonts.bold, fontSize: 11, color: colors.text },
  meta: { fontFamily: fonts.mono, fontSize: 9.5, color: colors.textMuted },
  dropPreview: { position: 'absolute', borderRadius: 8, borderWidth: 2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(34,211,238,0.08)' },
  dropText: { fontFamily: fonts.mono, fontSize: 10, color: colors.text },
  tray: { paddingTop: 10, paddingBottom: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1, minWidth: 84 },
  ghost: { position: 'absolute', borderRadius: 10, borderWidth: 2, padding: 5, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 12, elevation: 12 },
});
