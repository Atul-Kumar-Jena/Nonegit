import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { CheckCircle2, Hand, Inbox, UserRound, XOctagon } from 'lucide-react-native';
import type { Availability, StaffSession } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Avatar, Badge, Card, ErrorState, Loading, Notice, SectionLabel, Text } from '@kit/components/ui';
import { clock, dayLabel, initials, to12h, zoned } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { DayPicker, Empty, Header, addDays } from '@/components/forms';
import { CoverSheet } from '@/components/Requests';
import { useDrag } from '@/planner/Board';
import { useAvailability, useChangeRequests, useCan, useMe, useOverview, useSessionsOn } from '@/queries';
import { ymdIn } from '@/time';

type Teacher = Availability['teachers'][number];
type Verdict = { ok: boolean; text: string };

const overlaps = (aS: string, aE: string, bS: string, bE: string) => aS < bE && bS < aE;

/**
 * Cover a class: every teacher with where they are right now, and the day's classes.
 * Long-press a teacher, drag them onto a class, add notes, send. The teacher accepts
 * (or declines) on their phone; when they accept, the students are notified.
 */
export default function Cover() {
  const api = useApi();
  const me = useMe();
  const admin = useCan('planner');
  const overview = useOverview();
  const [offset, setOffset] = useState(0);
  const tz0 = overview.data?.timezone;
  const today = ymdIn(api.serverNow(), tz0);
  const date = addDays(today, offset);
  const avail = useAvailability(date);
  const tz = avail.data?.timezone ?? tz0;
  const sessionsQ = useSessionsOn(date);
  const reqs = useChangeRequests();
  const meId = me.data?.user.id;
  const nowMs = api.serverNow();
  const nowHm = zoned(nowMs, tz).hm;
  const clockHm = (iso: string) => zoned(iso, tz).hm;

  const [picked, setPicked] = useState<string | null>(null); // tap-to-assign alternative
  /** A class tapped first: every teacher then shows whether they're free at its time. */
  const [selected, setSelected] = useState<string | null>(null);
  const [allTeachers, setAllTeachers] = useState(false);
  const [sheet, setSheet] = useState<{ session: StaffSession; teacherId: string | null } | null>(null);
  const [toast, setToast] = useState<{ tone: 'red' | 'green' | 'amber'; text: string } | null>(null);

  // ── data ──
  const classes = useMemo(
    () =>
      (sessionsQ.data ?? [])
        .filter((s) => s.status === 'scheduled' && Date.parse(s.scheduledEnd) > nowMs)
        .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart)),
    [sessionsQ.data, admin, meId, nowMs],
  );
  const pendingBySession = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of reqs.data?.outgoing ?? []) if (r.kind === 'cover' && r.status === 'pending') m.set(r.session.id, r.to.name);
    return m;
  }, [reqs.data]);
  const teachers = useMemo(() => {
    const list = (avail.data?.teachers ?? []).map((t) => {
      const blocks = t.busy.filter((b) => b.date === date && b.status !== 'cancelled').sort((a, b) => a.start.localeCompare(b.start));
      const current = offset === 0 ? blocks.find((b) => b.start <= nowHm && nowHm < b.end) : undefined;
      const next = offset === 0 ? blocks.find((b) => b.start > nowHm) : undefined;
      const status =
        offset !== 0
          ? blocks.length
            ? `${blocks.length} ${blocks.length === 1 ? 'class' : 'classes'} that day`
            : 'Free all day'
          : current
            ? `In ${current.courseCode} till ${to12h(current.end)}`
            : next
              ? `Free now · next ${to12h(next.start)}`
              : 'Free now · done for the day';
      return { t, free: offset === 0 ? !current : blocks.length === 0, status, blocks };
    });
    return list.sort((a, b) => Number(b.free) - Number(a.free) || a.t.name.localeCompare(b.t.name));
  }, [avail.data, date, offset, nowHm]);

  const verdict = useCallback(
    (t: Teacher, s: StaffSession): Verdict => {
      if ((s.substitute?.id ?? s.teacher?.id) === t.id) return { ok: false, text: `${t.name} already takes this class` };
      const start = zoned(s.scheduledStart, tz).hm;
      const end = zoned(s.scheduledEnd, tz).hm;
      const clash = t.busy.find((b) => b.sessionId !== s.id && b.date === date && b.status !== 'cancelled' && overlaps(start, end, b.start, b.end));
      if (clash) return { ok: false, text: `${t.name} teaches ${clash.courseCode} ${clash.start}–${clash.end}${clash.room ? ` in ${clash.room}` : ''} then` };
      return { ok: true, text: `${t.name} is free then` };
    },
    [tz, date],
  );

  // ── drag & drop ──
  const rootRef = useRef<View>(null);
  const listRef = useRef<ScrollView>(null);
  const listBoxRef = useRef<View>(null);
  const root = useRef({ x: 0, y: 0 });
  const list = useRef({ x: 0, y: 0, w: 0, h: 0, scroll: 0 });
  const cardRefs = useRef(new Map<string, View | null>());
  // Card rectangles in page coordinates (the finger's space), measured when a drag starts.
  const cards = useRef(new Map<string, { x: number; y: number; w: number; h: number }>());
  const scrollAtMeasure = useRef(0);
  const [drag, setDrag] = useState<{ t: Teacher; x: number; y: number } | null>(null);
  const [over, setOver] = useState<{ id: string; v: Verdict } | null>(null);
  const autoScroll = useRef<ReturnType<typeof setInterval> | null>(null);
  const pointer = useRef({ x: 0, y: 0 });

  const hit = useCallback(
    (x: number, y: number): StaffSession | null => {
      const L = list.current;
      if (x < L.x || x > L.x + L.w || y < L.y || y > L.y + L.h) return null;
      const shift = L.scroll - scrollAtMeasure.current; // auto-scrolled since measuring
      for (const s of classes) {
        const r = cards.current.get(s.id);
        if (!r) continue;
        const top = r.y - shift;
        if (y >= top && y <= top + r.h && x >= r.x && x <= r.x + r.w) return s;
      }
      return null;
    },
    [classes],
  );

  const stopAuto = () => {
    if (autoScroll.current) clearInterval(autoScroll.current);
    autoScroll.current = null;
  };
  const updateOver = useCallback(
    (t: Teacher, x: number, y: number) => {
      const s = hit(x, y);
      setOver((prev) => {
        if (!s) return prev ? null : prev;
        if (prev?.id === s.id) return prev;
        const v = verdict(t, s);
        void Haptics.selectionAsync().catch(() => undefined);
        return { id: s.id, v };
      });
    },
    [hit, verdict],
  );

  const measureCards = useCallback(() => {
    scrollAtMeasure.current = list.current.scroll;
    for (const [id, ref] of cardRefs.current) ref?.measure((_x, _y, w, h, px, py) => cards.current.set(id, { x: px, y: py, w, h }));
  }, []);

  const onStart = useCallback((t: Teacher, x: number, y: number) => {
    rootRef.current?.measure((_x, _y, _w, _h, rx, ry) => (root.current = { x: rx, y: ry }));
    listBoxRef.current?.measure((_x, _y, lw, lh, lx, ly) => (list.current = { ...list.current, x: lx, y: ly, w: lw, h: lh }));
    measureCards();
    setPicked(null);
    setToast(null);
    pointer.current = { x, y };
    setDrag({ t, x, y });
  }, [measureCards]);

  const onMove = useCallback(
    (t: Teacher, x: number, y: number) => {
      pointer.current = { x, y };
      setDrag({ t, x, y });
      updateOver(t, x, y);
      const L = list.current;
      const dir = y > L.y + L.h - 70 ? 1 : y < L.y + 50 && y > L.y - 40 ? -1 : 0;
      if (!dir) return stopAuto();
      if (autoScroll.current) return;
      autoScroll.current = setInterval(() => {
        list.current.scroll = Math.max(0, list.current.scroll + dir * 14);
        listRef.current?.scrollTo({ y: list.current.scroll, animated: false });
        updateOver(t, pointer.current.x, pointer.current.y);
      }, 30);
    },
    [updateOver],
  );

  const onEnd = useCallback(
    (t: Teacher, x: number, y: number) => {
      stopAuto();
      setDrag(null);
      setOver(null);
      const s = hit(x, y);
      if (!s) return;
      const v = verdict(t, s);
      if (!v.ok) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
        setToast({ tone: 'red', text: v.text });
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setSheet({ session: s, teacherId: t.id });
    },
    [hit, verdict],
  );

  const onCancel = useCallback(() => {
    stopAuto();
    setDrag(null);
    setOver(null);
  }, []);

  if (me.data && !admin)
    return (
      <Screen>
        <Header info="cover" title="Cover a class" />
        <Empty title="Needs “Planner & cover”" message="Admins (principal / HOD) — and professors they give the “Planner & cover” permission — hand classes to other professors. When you're asked to take one, it appears in Requests: accept or decline it there." />
      </Screen>
    );
  if (sessionsQ.isPending || avail.isPending)
    return (
      <Screen scroll={false}>
        <Header info="cover" title="Cover a class" />
        <Loading label="Loading teachers and classes…" />
      </Screen>
    );
  if (sessionsQ.error || avail.error)
    return (
      <Screen>
        <Header info="cover" title="Cover a class" />
        <ErrorState message={(sessionsQ.error ?? avail.error)?.message ?? 'Couldn’t load.'} onRetry={() => (void sessionsQ.refetch(), void avail.refetch())} />
      </Screen>
    );

  const pickedTeacher = teachers.find((x) => x.t.id === picked)?.t;
  const selectedClass = classes.find((c) => c.id === selected) ?? null;
  const incoming = (reqs.data?.incoming ?? []).filter((r) => r.status === 'pending').length;
  const sent = (reqs.data?.outgoing ?? []).filter((r) => r.status === 'pending').length;

  return (
    <Screen scroll={false}>
      <View ref={rootRef} style={{ flex: 1 }} collapsable={false}>
        <Header info="cover" title="Cover a class" subtitle="Hand a class to a free teacher" />
        <View style={{ marginTop: 8 }}>
          <DayPicker
            today={today}
            value={date}
            onChange={(d) => {
              setOffset(Math.max(0, [0, 1, 2, 3, 4, 5, 6].find((i) => addDays(today, i) === d) ?? 0));
              setPicked(null);
              setSelected(null);
            }}
          />
        </View>

        <SectionLabel right={<Text variant="monoSmall">{offset === 0 ? `now ${nowHm}` : dayLabel(`${date}T12:00:00Z`, 'UTC')}</Text>}>Teachers</SectionLabel>
        {/* A plain wrapped grid (no scrolling parent), so a scroll view can never steal the finger mid-drag. */}
        <View style={styles.tray}>
          {(selectedClass
            ? [...teachers].sort((a, b) => Number(verdict(b.t, selectedClass).ok) - Number(verdict(a.t, selectedClass).ok))
            : allTeachers
              ? teachers
              : teachers.slice(0, 6)
          ).map(({ t, free, status, blocks }) => {
            const v = selectedClass ? verdict(t, selectedClass) : null;
            return (
            <TeacherChip
              key={t.id}
              t={t}
              free={v ? v.ok : free}
              status={v ? (v.ok ? `Free for ${selectedClass!.courseCode} ✓` : v.text.replace(`${t.name} `, '')) : status}
              blocks={blocks}
              highlight={selectedClass ? { start: clockHm(selectedClass.scheduledStart), end: clockHm(selectedClass.scheduledEnd) } : null}
              me={t.id === meId}
              picked={picked === t.id}
              dragging={drag?.t.id === t.id}
              onTap={() => {
                if (selectedClass) {
                  const vv = verdict(t, selectedClass);
                  if (!vv.ok) return setToast({ tone: 'red', text: vv.text });
                  setSheet({ session: selectedClass, teacherId: t.id });
                  setSelected(null);
                } else setPicked((p) => (p === t.id ? null : t.id));
              }}
              onStart={onStart}
              onMove={onMove}
              onEnd={onEnd}
              onCancel={onCancel}
            />
            );
          })}
          {!selectedClass && teachers.length > 6 ? (
            <Pressable onPress={() => setAllTeachers((v) => !v)} accessibilityRole="button" style={[styles.chip, { borderColor: colors.border }]}>
              <Text variant="small" color={colors.text}>
                {allTeachers ? 'Show fewer' : `+${teachers.length - 6} more`}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <View style={[styles.row, { marginTop: 8 }]}>
          <Hand color={colors.textDim} size={13} />
          <Text variant="small" style={{ flex: 1 }}>
            {selectedClass
              ? `${selectedClass.courseCode} ${clock(selectedClass.scheduledStart, tz)} selected — tap a free (green) teacher to ask them.`
              : pickedTeacher
                ? `Now tap a class to give it to ${pickedTeacher.name}.`
                : 'Hold a teacher and drop them on a class — or tap a class to see who’s free then.'}
          </Text>
        </View>
        {toast ? (
          <View style={{ marginTop: 8 }}>
            <Notice tone={toast.tone} message={toast.text} onDismiss={() => setToast(null)} />
          </View>
        ) : null}

        <View ref={listBoxRef} collapsable={false} style={{ flex: 1, marginTop: 8 }}>
          <ScrollView
            ref={listRef}
            style={{ flex: 1 }}
            scrollEnabled={!drag}
            onScroll={(e) => (list.current.scroll = e.nativeEvent.contentOffset.y)}
            scrollEventThrottle={16}
            contentContainerStyle={{ paddingBottom: 40 }}
          >
            <Pressable onPress={() => router.push('/inbox')} accessibilityRole="button" style={[styles.row, styles.inbox]}>
              <Inbox color={incoming ? colors.violet : colors.textDim} size={16} />
              <Text variant="small" style={{ flex: 1 }}>
                {incoming ? `${incoming} waiting for your answer` : 'No requests waiting for you'}
                {sent ? ` · ${sent} sent, waiting` : ''}
              </Text>
              <Text variant="small" color={colors.cyan}>
                Requests
              </Text>
            </Pressable>
            <View style={{ gap: 10 }}>
              {classes.length === 0 ? (
                <Empty title="No classes to cover" message={offset === 0 ? 'Nothing left today that could be handed over.' : 'No scheduled classes that day.'} />
              ) : (
                classes.map((s) => {
                  const o = over?.id === s.id ? over.v : null;
                  // While a teacher is being dragged, every class says at once whether they're free for it.
                  const live = drag && !o ? verdict(drag.t, s) : null;
                  const isSel = selected === s.id;
                  const waiting = pendingBySession.get(s.id);
                  return (
                    <Pressable
                      key={s.id}
                      ref={(r) => {
                        cardRefs.current.set(s.id, r as View | null);
                      }}
                      collapsable={false}
                      onPress={() => {
                        if (pickedTeacher) {
                          const v = verdict(pickedTeacher, s);
                          if (!v.ok) return setToast({ tone: 'red', text: v.text });
                          setSheet({ session: s, teacherId: pickedTeacher.id });
                          setPicked(null);
                        } else setSelected((cur) => (cur === s.id ? null : s.id));
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`${s.courseCode} ${clock(s.scheduledStart, tz)}. ${waiting ? `Waiting for ${waiting}. ` : ''}Tap to choose who covers it.`}
                    >
                      <Card
                        style={[
                          styles.classCard,
                          o ? { borderColor: o.ok ? colors.green : colors.red, borderWidth: 2, backgroundColor: o.ok ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)' } : null,
                          live ? { borderStyle: 'dashed', borderColor: live.ok ? 'rgba(74,222,128,0.6)' : 'rgba(248,113,113,0.5)', opacity: live.ok ? 1 : 0.6 } : null,
                          isSel ? { borderColor: colors.text, borderWidth: 2 } : null,
                        ]}
                      >
                        <View style={styles.time}>
                          <Text style={styles.timeText}>{clock(s.scheduledStart, tz)}</Text>
                          <Text variant="monoSmall">{clock(s.scheduledEnd, tz)}</Text>
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text variant="bodyStrong" numberOfLines={1}>
                            {s.courseCode} · {s.courseTitle}
                          </Text>
                          <Text variant="small" numberOfLines={1}>
                            {s.substitute ? `${s.substitute.name} (covering)` : (s.teacher?.name ?? 'No teacher')}
                            {s.roomLabel ? ` · ${s.roomLabel}` : ''}
                          </Text>
                          {o ? (
                            <View style={styles.row}>
                              {o.ok ? <CheckCircle2 color={colors.green} size={13} /> : <XOctagon color={colors.red} size={13} />}
                              <Text variant="small" color={o.ok ? colors.green : colors.red} style={{ flex: 1 }}>
                                {o.ok ? `Drop to ask ${drag?.t.name ?? ''}` : o.text}
                              </Text>
                            </View>
                          ) : live ? (
                            <View style={styles.row}>
                              {live.ok ? <CheckCircle2 color={colors.green} size={13} /> : <XOctagon color={colors.red} size={13} />}
                              <Text variant="small" color={live.ok ? colors.green : colors.red} style={{ flex: 1 }} numberOfLines={1}>
                                {live.ok ? 'Free then' : live.text.replace(`${drag!.t.name} `, '')}
                              </Text>
                            </View>
                          ) : isSel ? (
                            <Text variant="small" color={colors.text}>
                              Selected — pick a green teacher above, or{' '}
                              <Text variant="small" color={colors.text} style={{ textDecorationLine: 'underline' }} onPress={() => setSheet({ session: s, teacherId: null })}>
                                choose from a list
                              </Text>
                            </Text>
                          ) : waiting ? (
                            <Badge label={`Waiting for ${waiting}`} tone="amber" />
                          ) : s.change?.kind === 'substitute' ? (
                            <Badge label="Covered" tone="violet" />
                          ) : null}
                        </View>
                      </Card>
                    </Pressable>
                  );
                })
              )}
            </View>
          </ScrollView>
        </View>

        {drag ? (
          <View pointerEvents="none" style={[styles.ghost, { left: drag.x - root.current.x - 60, top: drag.y - root.current.y - 26 }]}>
            <UserRound color={colors.bg} size={14} />
            <Text style={styles.ghostText} numberOfLines={1}>
              {drag.t.name}
            </Text>
          </View>
        ) : null}
      </View>

      {sheet ? (
        <CoverSheet
          session={sheet.session}
          teacherId={sheet.teacherId}
          tz={tz}
          meId={meId}
          onClose={(r) => {
            setSheet(null);
            if (r) setToast({ tone: 'green', text: r.status === 'applied' ? 'Done — the class is yours and its students were notified.' : 'Request sent. You’ll be notified when they answer.' });
          }}
        />
      ) : null}
    </Screen>
  );
}

/** 8 AM → 6 PM strip with the teacher's classes drawn in (and the selected class outlined). */
function DayStrip({ blocks, highlight }: { blocks: { start: string; end: string }[]; highlight: { start: string; end: string } | null }) {
  const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const from = 8 * 60;
  const span = 10 * 60;
  const pct = (m: number) => `${Math.max(0, Math.min(100, ((m - from) / span) * 100))}%` as const;
  const w = (a: string, b: string) => `${Math.max(2, ((Math.min(toMin(b), from + span) - Math.max(toMin(a), from)) / span) * 100)}%` as const;
  return (
    <View style={styles.strip}>
      {blocks.map((b, i) => (
        <View key={i} style={[styles.stripBusy, { left: pct(toMin(b.start)), width: w(b.start, b.end) }]} />
      ))}
      {highlight ? <View style={[styles.stripSel, { left: pct(toMin(highlight.start)), width: w(highlight.start, highlight.end) }]} /> : null}
    </View>
  );
}

function TeacherChip({
  t,
  free,
  status,
  blocks,
  highlight,
  me,
  picked,
  dragging,
  onTap,
  onStart,
  onMove,
  onEnd,
  onCancel,
}: {
  t: Teacher;
  free: boolean;
  status: string;
  blocks: { start: string; end: string }[];
  highlight: { start: string; end: string } | null;
  me: boolean;
  picked: boolean;
  dragging: boolean;
  onTap: () => void;
  onStart: (t: Teacher, x: number, y: number) => void;
  onMove: (t: Teacher, x: number, y: number) => void;
  onEnd: (t: Teacher, x: number, y: number) => void;
  onCancel: () => void;
}) {
  const handlers = useDrag({
    disabled: false,
    onTap,
    onStart: (x, y) => onStart(t, x, y),
    onMove: (x, y) => onMove(t, x, y),
    onEnd: (x, y) => onEnd(t, x, y),
    onCancel,
  });
  return (
    <View
      {...handlers.panHandlers}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${t.name}${me ? ' (you)' : ''}: ${status}. Tap, then tap a class; or long-press and drag onto a class.`}
      style={[styles.chip, { borderColor: picked ? colors.cyan : free ? 'rgba(52,211,153,0.5)' : colors.border, opacity: dragging ? 0.35 : 1 }, picked && { backgroundColor: colors.cyanSoft }]}
    >
      <Avatar text={initials(t.name)} size={30} />
      <View style={{ maxWidth: 190 }}>
        <Text variant="bodyStrong" numberOfLines={2} style={{ fontSize: 15 }}>
          {t.name}
          {me ? ' (you)' : ''}
        </Text>
        <Text variant="small" color={free ? colors.green : colors.amber} numberOfLines={2}>
          {status}
        </Text>
        <DayStrip blocks={blocks} highlight={highlight} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tray: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  strip: { height: 5, width: 120, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.08)', marginTop: 5, overflow: 'hidden' },
  stripBusy: { position: 'absolute', top: 0, bottom: 0, backgroundColor: colors.amber, borderRadius: 2 },
  stripSel: { position: 'absolute', top: 0, bottom: 0, borderWidth: 1, borderColor: colors.text, borderRadius: 2 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 16, borderWidth: 1.5, backgroundColor: colors.card },
  inbox: { padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, marginBottom: 10 },
  classCard: { flexDirection: 'row', gap: 12, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  time: { width: 72, alignItems: 'center' },
  timeText: { fontFamily: fonts.bold, fontSize: 14, color: colors.text },
  ghost: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 200,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: colors.cyan,
    transform: [{ scale: 1.08 }],
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 8,
  },
  ghostText: { fontFamily: fonts.bold, fontSize: 13, color: colors.bg },
});
