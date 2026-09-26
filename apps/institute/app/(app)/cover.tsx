import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type LayoutRectangle } from 'react-native';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { CheckCircle2, Hand, Inbox, UserRound, XOctagon } from 'lucide-react-native';
import type { Availability, StaffSession } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Avatar, Badge, Card, ErrorState, Loading, Notice, SectionLabel, Text } from '@kit/components/ui';
import { dayLabel, initials, zoned } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { Empty, Header, addDays } from '@/components/forms';
import { CoverSheet } from '@/components/Requests';
import { useDrag } from '@/planner/Board';
import { useAvailability, useChangeRequests, useIsAdmin, useMe, useOverview, useSessionsOn } from '@/queries';
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
  const admin = useIsAdmin();
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

  const [picked, setPicked] = useState<string | null>(null); // tap-to-assign alternative
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
            ? `In ${current.courseCode} till ${current.end}`
            : next
              ? `Free now · next ${next.start}`
              : 'Free now · done for the day';
      return { t, free: offset === 0 ? !current : blocks.length === 0, status };
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
  const cards = useRef(new Map<string, LayoutRectangle>());
  const listTop = useRef(0); // y of the class list inside the scroll content
  const [drag, setDrag] = useState<{ t: Teacher; x: number; y: number } | null>(null);
  const [over, setOver] = useState<{ id: string; v: Verdict } | null>(null);
  const autoScroll = useRef<ReturnType<typeof setInterval> | null>(null);
  const pointer = useRef({ x: 0, y: 0 });

  const hit = useCallback(
    (x: number, y: number): StaffSession | null => {
      const L = list.current;
      if (x < L.x || x > L.x + L.w || y < L.y || y > L.y + L.h) return null;
      for (const s of classes) {
        const r = cards.current.get(s.id);
        if (!r) continue;
        const top = L.y + listTop.current + r.y - L.scroll;
        if (y >= top && y <= top + r.height) return s;
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

  const onStart = useCallback((t: Teacher, x: number, y: number) => {
    rootRef.current?.measureInWindow((rx, ry) => (root.current = { x: rx, y: ry }));
    listBoxRef.current?.measureInWindow((lx, ly, lw, lh) => (list.current = { ...list.current, x: lx, y: ly, w: lw, h: lh }));
    setPicked(null);
    setToast(null);
    pointer.current = { x, y };
    setDrag({ t, x, y });
  }, []);

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
        <Header title="Cover a class" />
        <Empty title="For admins only" message="Only the principal or an HOD hands classes to other teachers. When they ask you to take one, it appears in Requests — accept or decline it there." />
      </Screen>
    );
  if (sessionsQ.isPending || avail.isPending)
    return (
      <Screen scroll={false}>
        <Header title="Cover a class" />
        <Loading label="Loading teachers and classes…" />
      </Screen>
    );
  if (sessionsQ.error || avail.error)
    return (
      <Screen>
        <Header title="Cover a class" />
        <ErrorState message={(sessionsQ.error ?? avail.error)?.message ?? 'Couldn’t load.'} onRetry={() => (void sessionsQ.refetch(), void avail.refetch())} />
      </Screen>
    );

  const pickedTeacher = teachers.find((x) => x.t.id === picked)?.t;
  const incoming = (reqs.data?.incoming ?? []).filter((r) => r.status === 'pending').length;
  const sent = (reqs.data?.outgoing ?? []).filter((r) => r.status === 'pending').length;

  return (
    <Screen scroll={false}>
      <View ref={rootRef} style={{ flex: 1 }} collapsable={false}>
        <Header title="Cover a class" subtitle="Admin · any class, any teacher" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingRight: 16 }}>
          {[0, 1, 2, 3, 4, 5, 6].map((i) => {
            const on = offset === i;
            return (
              <Pressable
                key={i}
                onPress={() => {
                  setOffset(i);
                  setPicked(null);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                style={[styles.day, on && styles.dayOn]}
              >
                <Text variant="small" color={on ? colors.text : colors.textMuted}>
                  {i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : dayLabel(`${addDays(today, i)}T12:00:00Z`, 'UTC')}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <SectionLabel right={<Text variant="monoSmall">{offset === 0 ? `now ${nowHm}` : dayLabel(`${date}T12:00:00Z`, 'UTC')}</Text>}>Teachers</SectionLabel>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingRight: 16, alignItems: 'flex-start' }} scrollEnabled={!drag}>
          {teachers.map(({ t, free, status }) => (
            <TeacherChip
              key={t.id}
              t={t}
              free={free}
              status={status}
              me={t.id === meId}
              picked={picked === t.id}
              dragging={drag?.t.id === t.id}
              onTap={() => setPicked((p) => (p === t.id ? null : t.id))}
              onStart={onStart}
              onMove={onMove}
              onEnd={onEnd}
              onCancel={onCancel}
            />
          ))}
        </ScrollView>
        <View style={[styles.row, { marginTop: 8 }]}>
          <Hand color={colors.textDim} size={13} />
          <Text variant="small" style={{ flex: 1 }}>
            {pickedTeacher ? `Now tap a class to give it to ${pickedTeacher.name}.` : 'Long-press a teacher and drop them on a class — or tap a teacher, then a class.'}
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
            <View onLayout={(e) => (listTop.current = e.nativeEvent.layout.y)} style={{ gap: 10 }}>
              {classes.length === 0 ? (
                <Empty title="No classes to cover" message={offset === 0 ? 'Nothing left today that could be handed over.' : 'No scheduled classes that day.'} />
              ) : (
                classes.map((s) => {
                  const o = over?.id === s.id ? over.v : null;
                  const waiting = pendingBySession.get(s.id);
                  return (
                    <Pressable
                      key={s.id}
                      onLayout={(e) => cards.current.set(s.id, e.nativeEvent.layout)}
                      onPress={() => {
                        if (pickedTeacher) {
                          const v = verdict(pickedTeacher, s);
                          if (!v.ok) return setToast({ tone: 'red', text: v.text });
                          setSheet({ session: s, teacherId: pickedTeacher.id });
                          setPicked(null);
                        } else setSheet({ session: s, teacherId: null });
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`${s.courseCode} ${zoned(s.scheduledStart, tz).hm}. ${waiting ? `Waiting for ${waiting}. ` : ''}Tap to choose who covers it.`}
                    >
                      <Card
                        style={[
                          styles.classCard,
                          o ? { borderColor: o.ok ? colors.green : colors.red, borderWidth: 2, backgroundColor: o.ok ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)' } : null,
                          drag && !o ? { borderStyle: 'dashed', borderColor: colors.borderHi } : null,
                        ]}
                      >
                        <View style={styles.time}>
                          <Text style={styles.timeText}>{zoned(s.scheduledStart, tz).hm}</Text>
                          <Text variant="monoSmall">{zoned(s.scheduledEnd, tz).hm}</Text>
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

function TeacherChip({
  t,
  free,
  status,
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
      <View style={{ maxWidth: 150 }}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {t.name}
          {me ? ' (you)' : ''}
        </Text>
        <Text variant="small" color={free ? colors.green : colors.amber} numberOfLines={1}>
          {status}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  day: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised },
  dayOn: { borderColor: colors.cyan, backgroundColor: colors.cyanSoft },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 16, borderWidth: 1.5, backgroundColor: colors.card },
  inbox: { padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, marginBottom: 10 },
  classCard: { flexDirection: 'row', gap: 12, alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  time: { width: 50, alignItems: 'center' },
  timeText: { fontFamily: fonts.bold, fontSize: 16, color: colors.text },
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
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 8,
  },
  ghostText: { fontFamily: fonts.bold, fontSize: 13, color: colors.bg },
});
