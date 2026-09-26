import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ChevronLeft, ChevronRight, CloudOff, FileClock, ListChecks, Undo2, ZoomIn, ZoomOut } from 'lucide-react-native';
import {
  addDaysYmd,
  applyOps,
  dateInWeek,
  findConflicts,
  hmToMin,
  isPast,
  minToHm,
  mondayOf,
  moveOp,
  opCounts,
  removeOpsFor,
  swapOps,
  upsertOp,
  weekdayOf,
  randomToken,
  type DraftOp,
  type PlannerConflict,
  type PlannerCourse,
  type PlannerItem,
  type PublishResponse,
} from '@attendly/protocol';
import { Backdrop } from '@kit/components/Screen';
import { Badge, Button, Card, IconButton, Input, Loading, Notice, Segmented, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { ConflictList, TeacherPicker } from '@/components/Adjust';
import { DateField, Field, Select, Sheet, TimeField, confirmAction, fromMinutes, toMinutes } from '@/components/forms';
import { Board, type DragSource, type DropTarget, t12 } from '@/planner/Board';
import { describeOp, type KnownSession } from '@/planner/describe';
import { useDraft } from '@/planner/useDraft';
import { useIsAdmin, useOverview, usePlannerWeek } from '@/queries';
import { InfoButton } from '@kit/components/Features';
import { HELP } from '@/help';
import { ymdIn } from '@/time';

type Scope = 'once' | 'weekly';
type FilterKind = 'all' | 'batch' | 'teacher' | 'room';
const conflictId = (c: PlannerConflict) => `${c.kind}|${[...c.keys].sort().join('|')}`;
const newTempId = () => randomToken(9).replace(/[^A-Za-z0-9_-]/g, 'x');

/**
 * The admin's timetable planner: drag classes across the week, swap them, give
 * them to another teacher or room, add or cancel classes — for this week only or
 * for every week — see clashes live, then publish once. Every affected student
 * and teacher is notified; nothing changes for anyone until you publish.
 */
export default function Planner() {
  const api = useApi();
  const admin = useIsAdmin();
  const tz = useOverview().data?.timezone;
  const [weekStart, setWeekStart] = useState(() => mondayOf(ymdIn(api.serverNow(), tz)));
  const weekQ = usePlannerWeek(weekStart);
  const week = weekQ.data;
  const d = useDraft(weekStart);
  const [scope, setScope] = useState<Scope>('once');
  // Wide, readable columns by default; zoom out to see the whole week at once.
  const [compact, setCompact] = useState(false);
  const [filterKind, setFilterKind] = useState<FilterKind>('all');
  const [filterId, setFilterId] = useState<string | null>(null);
  const [history, setHistory] = useState<DraftOp[][]>([]);
  const [selected, setSelected] = useState<PlannerItem | null>(null);
  const [adding, setAdding] = useState<PlannerCourse | null>(null);
  const [swap, setSwap] = useState<{ a: PlannerItem; b: PlannerItem; target: DropTarget } | null>(null);
  const [review, setReview] = useState(false);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Remember every class seen in any week, so changes to other weeks still read well.
  const known = useRef(new Map<string, KnownSession>());
  useEffect(() => {
    for (const it of week?.items ?? []) if (it.sessionId) known.current.set(it.sessionId, { courseId: it.courseId, date: it.date, start: it.start });
  }, [week]);

  const maps = useMemo(
    () => ({
      courses: new Map((week?.courses ?? []).map((c) => [c.id, c])),
      rooms: new Map((week?.rooms ?? []).map((r) => [r.id, r.name])),
      teachers: new Map((week?.teachers ?? []).map((t) => [t.id, t.name])),
      slots: new Map((week?.slots ?? []).map((s) => [s.id, { courseId: s.courseId, weekday: s.weekday, start: s.start }])),
    }),
    [week],
  );

  const applied = useMemo(() => (week ? applyOps(week, d.ops) : { items: [], errors: [] }), [week, d.ops]);
  const { newConflicts, highlight } = useMemo(() => {
    if (!week) return { newConflicts: [] as PlannerConflict[], highlight: new Map<string, 'error' | 'warning'>() };
    const before = new Set(findConflicts(week.items, week.courses).map(conflictId));
    const after = findConflicts(applied.items, week.courses, { teachers: maps.teachers, rooms: maps.rooms });
    const fresh = after.filter((c) => !before.has(conflictId(c)));
    const h = new Map<string, 'error' | 'warning'>();
    for (const c of fresh) for (const k of c.keys) if (h.get(k) !== 'error') h.set(k, c.severity);
    return { newConflicts: fresh, highlight: h };
  }, [week, applied.items, maps]);

  const visible = useMemo(() => {
    if (filterKind === 'all' || !filterId) return applied.items;
    return applied.items.filter((i) =>
      filterKind === 'batch' ? maps.courses.get(i.courseId)?.batchIds.includes(filterId) : filterKind === 'teacher' ? i.teacherId === filterId : i.roomId === filterId,
    );
  }, [applied.items, filterKind, filterId, maps]);

  const tray = useMemo(() => {
    const all = (week?.courses ?? []).filter((c) => c.active);
    if (filterKind === 'batch' && filterId) return all.filter((c) => c.batchIds.includes(filterId));
    if (filterKind === 'teacher' && filterId) return all.filter((c) => c.instructorId === filterId);
    return all;
  }, [week, filterKind, filterId]);

  const days = useMemo(() => {
    const all = Array.from({ length: 7 }, (_, i) => addDaysYmd(weekStart, i));
    const sunday = all[6]!;
    return applied.items.some((i) => i.date === sunday) ? all : all.slice(0, 6);
  }, [weekStart, applied.items]);

  if (!admin) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <Backdrop />
        <View style={{ padding: 20 }}>
          <Notice tone="amber" message="The planner is for admins. Teachers can move, cancel or hand over their own classes from the class screen." />
        </View>
      </SafeAreaView>
    );
  }

  function change(next: DraftOp[]) {
    setHistory((h) => [...h.slice(-30), d.ops]);
    d.setOps(next);
  }

  function effectiveScope(it: PlannerItem): Scope {
    if (scope === 'weekly' && !it.slotId && !it.key.startsWith('new:')) {
      setNotice('That class isn’t from the weekly timetable (it’s a one-off), so it was changed for this date only.');
      return 'once';
    }
    return scope;
  }

  function onDrop(src: DragSource, t: DropTarget) {
    if (!week) return;
    const start = minToHm(t.startMin);
    if (src.kind === 'course') {
      const end = minToHm(Math.min(t.startMin + 60, 23 * 60 + 59));
      if (scope === 'once' && isPast(t.date, start, week.today, week.now)) return setNotice('You can’t add a class in the past.');
      const tempId = newTempId();
      const op: DraftOp =
        scope === 'weekly'
          ? { op: 'slot.create', tempId, courseId: src.course.id, weekday: weekdayOf(t.date), start, end, roomId: null }
          : { op: 'extra', tempId, courseId: src.course.id, date: t.date, start, end, roomId: null };
      change([...d.ops, op]);
      setNotice(`${src.course.code} added — tap it to choose a room${scope === 'once' ? ' or teacher' : ''}.`);
      return;
    }
    const it = src.item;
    const over = t.overKey ? applied.items.find((i) => i.key === t.overKey) : undefined;
    if (over) return setSwap({ a: it, b: over, target: t });
    move(it, t.date, start);
  }

  function move(it: PlannerItem, date: string, start: string, roomId?: string | null) {
    if (!week) return;
    const s = effectiveScope(it);
    const dur = hmToMin(it.end) - hmToMin(it.start);
    const end = minToHm(Math.min(hmToMin(start) + dur, 23 * 60 + 59));
    if (s === 'once' && isPast(date, start, week.today, week.now)) return setNotice('You can’t move a class into the past.');
    const op = moveOp(it, { date, start, end, ...(roomId !== undefined ? { roomId } : {}) }, s, d.ops);
    if (!op) return setNotice('That class can’t be moved.');
    change(upsertOp(d.ops, op));
  }

  const counts = opCounts(d.ops);
  const errorsCount = applied.errors.length + newConflicts.filter((c) => c.severity === 'error').length;
  const warnCount = newConflicts.filter((c) => c.severity === 'warning').length;
  const weekLabel = `${Number(weekStart.slice(8))}/${Number(weekStart.slice(5, 7))} – ${Number(addDaysYmd(weekStart, 6).slice(8))}/${Number(addDaysYmd(weekStart, 6).slice(5, 7))}`;

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <Backdrop />
      <View style={styles.top}>
        <IconButton label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/timetable'))}>
          <ChevronLeft color={colors.text} size={18} />
        </IconButton>
        <Pressable onPress={() => setMenu(true)} style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel="Drafts">
          <Text variant="label" numberOfLines={1}>
            Planner · {d.draftId ? d.title : 'new draft'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text variant="heading">Week {weekLabel}</Text>
            <SaveBadge state={d.save} />
          </View>
        </Pressable>
        <IconButton label="Undo" onPress={() => history.length && (d.setOps(history[history.length - 1]!), setHistory((h) => h.slice(0, -1)))}>
          <Undo2 color={history.length ? colors.text : colors.textDim} size={18} />
        </IconButton>
        <InfoButton title={HELP.planner!.title} text={HELP.planner!.text} />
      </View>

      <View style={styles.controls}>
        <View style={styles.row}>
          <IconButton label="Previous week" onPress={() => setWeekStart(addDaysYmd(weekStart, -7))}>
            <ChevronLeft color={colors.text} size={16} />
          </IconButton>
          <Button title="This week" kind="secondary" compact onPress={() => week && setWeekStart(mondayOf(week.today))} />
          <IconButton label="Next week" onPress={() => setWeekStart(addDaysYmd(weekStart, 7))}>
            <ChevronRight color={colors.text} size={16} />
          </IconButton>
          <View style={{ flex: 1 }} />
          <IconButton label={compact ? 'Zoom in (wide days)' : 'Zoom out (whole week)'} onPress={() => setCompact((c) => !c)}>
            {compact ? <ZoomIn color={colors.text} size={18} /> : <ZoomOut color={colors.text} size={18} />}
          </IconButton>
        </View>
        <Segmented
          value={scope}
          options={[
            { value: 'once', label: 'Changes: this date only' },
            { value: 'weekly', label: 'Every week' },
          ]}
          onChange={setScope}
        />
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Segmented
              value={filterKind}
              options={[
                { value: 'all', label: 'All' },
                { value: 'batch', label: 'Batch' },
                { value: 'teacher', label: 'Teacher' },
                { value: 'room', label: 'Room' },
              ]}
              onChange={(k) => {
                setFilterKind(k);
                setFilterId(null);
              }}
            />
          </View>
        </View>
        {filterKind !== 'all' ? (
          <Select
            title={filterKind === 'batch' ? 'Batch' : filterKind === 'teacher' ? 'Teacher' : 'Room'}
            value={filterId}
            onChange={setFilterId}
            placeholder={`Choose a ${filterKind}`}
            options={
              filterKind === 'batch'
                ? (week?.batches ?? []).map((b) => ({ value: b.id, label: b.name, sub: `${b.size} students` }))
                : filterKind === 'teacher'
                  ? (week?.teachers ?? []).map((t) => ({ value: t.id, label: t.name }))
                  : (week?.rooms ?? []).map((r) => ({ value: r.id, label: r.name }))
            }
          />
        ) : null}
      </View>

      {d.notice ? <Notice tone="violet" message={d.notice} onDismiss={d.clearNotice} /> : null}
      {notice ? <Notice tone="cyan" message={notice} onDismiss={() => setNotice(null)} /> : null}

      <View style={{ flex: 1 }}>
        {!week ? (
          weekQ.isError ? (
            <View style={{ padding: 20 }}>
              <Notice tone="red" message={`${weekQ.error.message} The planner needs internet.`} />
            </View>
          ) : (
            <Loading label="Loading the week…" />
          )
        ) : (
          <Board
            days={days}
            items={visible}
            courses={maps.courses}
            rooms={maps.rooms}
            teachers={maps.teachers}
            conflicts={highlight}
            tray={tray}
            compact={compact}
            today={week.today}
            onTap={setSelected}
            onTrayTap={setAdding}
            onDrop={onDrop}
          />
        )}
      </View>

      <View style={styles.footer}>
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">
            {d.ops.length ? `${d.ops.length} ${d.ops.length === 1 ? 'change' : 'changes'}` : 'No changes yet'}
            {counts.weekly ? <Text variant="small"> · {counts.weekly} weekly</Text> : null}
          </Text>
          <Text variant="small" color={errorsCount ? colors.red : warnCount ? colors.amber : colors.textMuted}>
            {errorsCount ? `${errorsCount} ${errorsCount === 1 ? 'clash' : 'clashes'} to fix` : warnCount ? `${warnCount} to check` : d.ops.length ? 'No clashes' : 'Long-press a class to drag it'}
          </Text>
        </View>
        <Button title="Review & publish" compact onPress={() => setReview(true)} disabled={!d.ops.length} icon={<ListChecks color="#0a0a0a" size={16} />} />
      </View>

      {selected && week ? (
        <ClassSheet
          item={applied.items.find((i) => i.key === selected.key) ?? selected}
          scope={scope}
          week={week}
          maps={maps}
          ops={d.ops}
          onChange={(next) => change(next)}
          onMove={(it, date, start, roomId) => move(it, date, start, roomId)}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {adding && week ? (
        <AddSheet
          course={adding}
          scope={scope}
          week={week}
          weekStart={weekStart}
          rooms={week.rooms}
          onAdd={(op) => {
            change([...d.ops, op]);
            setAdding(null);
          }}
          onClose={() => setAdding(null)}
        />
      ) : null}
      {swap ? (
        <Sheet open onClose={() => setSwap(null)} title="Dropped on another class">
          <Text variant="small">
            {maps.courses.get(swap.a.courseId)?.code} was dropped on {maps.courses.get(swap.b.courseId)?.code} ({swap.b.start}).
          </Text>
          <Button
            title={`Swap their times${scope === 'weekly' ? ' (every week)' : ''}`}
            onPress={() => {
              const s = swap.a.slotId && swap.b.slotId ? scope : 'once';
              change(swapOps(swap.a, swap.b, s, d.ops));
              setSwap(null);
            }}
            style={{ marginTop: 14 }}
          />
          <Button
            title={`Put it at ${minToHm(swap.target.startMin)} anyway`}
            kind="secondary"
            onPress={() => {
              move(swap.a, swap.target.date, minToHm(swap.target.startMin));
              setSwap(null);
            }}
            style={{ marginTop: 10 }}
          />
        </Sheet>
      ) : null}
      {review && week ? (
        <ReviewSheet
          ops={d.ops}
          describe={(o) => describeOp(o, { courses: maps.courses, sessions: known.current, slots: maps.slots, teachers: maps.teachers, rooms: maps.rooms })}
          conflicts={newConflicts}
          errors={applied.errors}
          title={d.title}
          onRename={d.rename}
          onRemove={(i) => change(d.ops.filter((_, j) => j !== i))}
          publish={d.publish}
          onDiscard={() =>
            confirmAction('Discard this draft?', 'All its changes are thrown away. Nothing was published, so nobody is affected.', 'Discard', () => {
              void d.discard();
              setHistory([]);
              setReview(false);
            }, true)
          }
          onClose={() => setReview(false)}
        />
      ) : null}
      {menu ? (
        <Sheet open onClose={() => setMenu(false)} title="Drafts">
          <Text variant="small">Drafts are saved on the server as you work — continue on any admin’s phone. Nothing reaches students until you publish.</Text>
          <View style={{ gap: 8, marginTop: 12 }}>
            {d.drafts
              .filter((x) => x.status === 'draft')
              .map((x) => (
                <Pressable
                  key={x.id}
                  onPress={() => {
                    void d.openDraft(x.id);
                    setHistory([]);
                    setMenu(false);
                  }}
                  style={[styles.draftRow, x.id === d.draftId && { borderColor: colors.cyan }]}
                  accessibilityRole="button"
                >
                  <FileClock color={colors.textMuted} size={16} />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong">{x.title}</Text>
                    <Text variant="small">
                      {x.once + x.weekly} changes · {x.updatedBy ?? '—'}
                    </Text>
                  </View>
                  {x.id === d.draftId ? <Badge label="Open" tone="cyan" dot={false} /> : null}
                </Pressable>
              ))}
            {d.drafts.filter((x) => x.status !== 'draft').slice(0, 5).map((x) => (
              <View key={x.id} style={[styles.draftRow, { opacity: 0.6 }]}>
                <FileClock color={colors.textDim} size={16} />
                <Text variant="small" style={{ flex: 1 }}>
                  {x.title} · {x.status}
                </Text>
              </View>
            ))}
          </View>
        </Sheet>
      ) : null}
    </SafeAreaView>
  );
}

function SaveBadge({ state }: { state: string }) {
  if (state === 'saving') return <Badge label="Saving…" tone="muted" dot={false} />;
  if (state === 'saved') return <Badge label="Saved" tone="green" dot={false} />;
  if (state === 'offline') return <Badge label="Offline · kept on phone" tone="amber" icon={<CloudOff color={colors.amber} size={10} />} />;
  if (state === 'error') return <Badge label="Not saved" tone="red" dot={false} />;
  return null;
}

type Maps = { courses: Map<string, PlannerCourse>; rooms: Map<string, string>; teachers: Map<string, string> };

/** Everything about one class on the board, and every way to change it. */
function ClassSheet({
  item,
  scope,
  week,
  maps,
  ops,
  onChange,
  onMove,
  onClose,
}: {
  item: PlannerItem;
  scope: Scope;
  week: { today: string; now: string; rooms: { id: string; name: string }[] };
  maps: Maps;
  ops: DraftOp[];
  onChange: (ops: DraftOp[]) => void;
  onMove: (it: PlannerItem, date: string, start: string, roomId?: string | null) => void;
  onClose: () => void;
}) {
  const course = maps.courses.get(item.courseId);
  const isNew = item.key.startsWith('new:');
  const [tab, setTab] = useState<'move' | 'teacher' | 'cancel'>('move');
  const [date, setDate] = useState(item.date);
  const [start, setStart] = useState(item.start);
  const [roomId, setRoomId] = useState<string | null>(item.roomId);
  const [teacherId, setTeacherId] = useState<string | null>(item.substitute ? item.teacherId : null);
  const [reason, setReason] = useState('');
  const existingSub = ops.find((o) => o.op === 'substitute' && o.sessionId === item.sessionId) as Extract<DraftOp, { op: 'substitute' }> | undefined;
  const [noteToTeacher, setNoteToTeacher] = useState(existingSub?.noteToTeacher ?? '');
  const [noteToStudents, setNoteToStudents] = useState(existingSub?.noteToStudents ?? '');
  const dur = hmToMin(item.end) - hmToMin(item.start);
  const weeklyOnly = scope === 'weekly' && !!item.slotId;

  if (item.locked || item.status !== 'scheduled') {
    return (
      <Sheet open onClose={onClose} title={`${course?.code ?? 'Class'} · ${t12(hmToMin(item.start))}`}>
        <Text variant="small">
          {item.status === 'cancelled' ? 'This class is cancelled.' : 'This class has already started or ended, so it can’t be changed here.'} {course?.title}
        </Text>
        {item.pending.length ? <Button title="Undo draft changes to this class" kind="secondary" onPress={() => (onChange(removeOpsFor(ops, item.key, null)), onClose())} style={{ marginTop: 14 }} /> : null}
      </Sheet>
    );
  }

  const newOp = isNew ? ops.find((o) => ('tempId' in o ? `new:${o.tempId}` : '') === item.key) : undefined;
  return (
    <Sheet open onClose={onClose} title={`${course?.code ?? 'Class'} · ${course?.title ?? ''}`}>
      <Text variant="small">
        {`${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayOf(item.date)]} ${t12(hmToMin(item.start))}–${t12(hmToMin(item.end))}`}
        {item.roomId ? ` · ${maps.rooms.get(item.roomId)}` : ' · no room'} · {item.teacherId ? maps.teachers.get(item.teacherId) : 'no teacher'}
        {item.substitute ? ' (substitute)' : ''}
      </Text>
      {item.pending.length ? <Badge label={`Changed in this draft: ${item.pending.join(', ')}`} tone="violet" dot={false} /> : null}
      <View style={{ marginTop: 12 }}>
        <Segmented
          value={tab}
          options={[
            { value: 'move', label: 'Time & room' },
            ...(weeklyOnly ? [] : [{ value: 'teacher' as const, label: 'Teacher' }]),
            { value: 'cancel', label: isNew ? 'Remove' : weeklyOnly ? 'Remove slot' : 'Cancel' },
          ]}
          onChange={setTab}
        />
      </View>

      {tab === 'move' ? (
        <>
          {!weeklyOnly ? (
            <Field label="Date">
              <DateField value={date} onChange={setDate} />
            </Field>
          ) : (
            <Field label="Day (every week)">
              <Segmented
                value={String(weekdayOf(date))}
                options={[1, 2, 3, 4, 5, 6, 0].map((w) => ({ value: String(w), label: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][w]! }))}
                onChange={(w) => setDate(dateInWeek(mondayOf(item.date), Number(w)))}
              />
            </Field>
          )}
          <Field label={`Starts (lasts ${dur} min)`}>
            <TimeField label="Start" value={start} onChange={setStart} />
          </Field>
          <Field label="Room">
            <Select title="Room" value={roomId} onChange={setRoomId} allowNone="No room" options={week.rooms.map((r) => ({ value: r.id, label: r.name }))} />
          </Field>
          <Button
            title={weeklyOnly ? 'Move every week' : 'Move this class'}
            onPress={() => {
              onMove(item, date, start, roomId);
              onClose();
            }}
            disabled={date === item.date && start === item.start && roomId === item.roomId}
            style={{ marginTop: 14 }}
          />
          {toMinutes(start) + dur > 24 * 60 ? <Text variant="small" color={colors.red}>That would run past midnight.</Text> : null}
        </>
      ) : null}

      {tab === 'teacher' ? (
        <View style={{ marginTop: 12, gap: 10 }}>
          <TeacherPicker
            date={item.date}
            start={item.start}
            end={item.end}
            value={teacherId}
            onChange={setTeacherId}
            excludeSessionId={item.sessionId ?? undefined}
            courseTeacherId={course?.instructorId ?? null}
          />
          {!newOp && teacherId && teacherId !== course?.instructorId ? (
            <>
              <Input value={noteToTeacher} onChangeText={setNoteToTeacher} placeholder="Note to the teacher (optional)" maxLength={300} />
              <Input value={noteToStudents} onChangeText={setNoteToStudents} placeholder="Note to the students (optional)" maxLength={300} />
              <Text variant="small">On publish, the teacher is asked first. The class becomes theirs, and the students are told, when they accept.</Text>
            </>
          ) : null}
          <Button
            title="Use this teacher"
            onPress={() => {
              if (newOp && newOp.op === 'extra') onChange(ops.map((o) => (o === newOp ? { ...newOp, teacherId } : o)));
              else if (item.sessionId)
                onChange(
                  upsertOp(ops, {
                    op: 'substitute',
                    sessionId: item.sessionId,
                    teacherId,
                    ...(noteToTeacher.trim() ? { noteToTeacher: noteToTeacher.trim() } : {}),
                    ...(noteToStudents.trim() ? { noteToStudents: noteToStudents.trim() } : {}),
                  }),
                );
              onClose();
            }}
          />
        </View>
      ) : null}

      {tab === 'cancel' ? (
        isNew ? (
          <Button title="Remove this new class" kind="danger" onPress={() => (onChange(removeOpsFor(ops, item.key, null)), onClose())} style={{ marginTop: 14 }} />
        ) : weeklyOnly ? (
          <>
            <Text variant="small" style={{ marginTop: 12 }}>
              Removes this weekly slot: its future classes disappear for everyone. Past classes and attendance are kept.
            </Text>
            <Button title="Remove weekly slot" kind="danger" onPress={() => (onChange(upsertOp(ops, { op: 'slot.delete', slotId: item.slotId! })), onClose())} style={{ marginTop: 12 }} />
          </>
        ) : (
          <>
            <Field label="Reason (students see this)">
              <Input value={reason} onChangeText={setReason} placeholder="e.g. Teacher on leave" maxLength={200} />
            </Field>
            <Button
              title="Cancel this class"
              kind="danger"
              disabled={reason.trim().length < 3 || !item.sessionId}
              onPress={() => (onChange(upsertOp(ops, { op: 'cancel', sessionId: item.sessionId!, reason: reason.trim() })), onClose())}
              style={{ marginTop: 12 }}
            />
          </>
        )
      ) : null}

      {item.pending.length && !isNew ? (
        <Button title="Undo draft changes to this class" kind="ghost" onPress={() => (onChange(removeOpsFor(ops, item.key, item.slotId)), onClose())} style={{ marginTop: 10 }} />
      ) : null}
      <Text variant="small" style={{ marginTop: 8 }}>
        Tip: long-press a class on the week and drag it — drop on another class to swap.
      </Text>
    </Sheet>
  );
}

/** Add a class of a course: a one-off (this date) or a new weekly slot. */
function AddSheet({
  course,
  scope,
  week,
  weekStart,
  rooms,
  onAdd,
  onClose,
}: {
  course: PlannerCourse;
  scope: Scope;
  week: { today: string; now: string };
  weekStart: string;
  rooms: { id: string; name: string }[];
  onAdd: (op: DraftOp) => void;
  onClose: () => void;
}) {
  const firstDay = weekStart > week.today ? weekStart : week.today;
  const [date, setDate] = useState(firstDay);
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('11:00');
  const [roomId, setRoomId] = useState<string | null>(null);
  const past = scope === 'once' && isPast(date, start, week.today, week.now);
  const bad = toMinutes(end) <= toMinutes(start);
  return (
    <Sheet open onClose={onClose} title={`Add ${course.code}`}>
      <Text variant="small">{scope === 'weekly' ? 'A new weekly slot: this class every week from now on.' : 'A one-off class on one date (extra or make-up).'}</Text>
      {scope === 'weekly' ? (
        <Field label="Day (every week)">
          <Segmented
            value={String(weekdayOf(date))}
            options={[1, 2, 3, 4, 5, 6, 0].map((w) => ({ value: String(w), label: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][w]! }))}
            onChange={(w) => setDate(dateInWeek(weekStart, Number(w)))}
          />
        </Field>
      ) : (
        <Field label="Date">
          <DateField value={date} onChange={setDate} />
        </Field>
      )}
      <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
        <Field label="Starts">
          <TimeField
            label="Start"
            value={start}
            onChange={(v) => {
              setStart(v);
              if (toMinutes(v) >= toMinutes(end)) setEnd(fromMinutes(Math.min(toMinutes(v) + 60, 23 * 60 + 55)));
            }}
          />
        </Field>
        <Field label="Ends" error={bad ? 'After the start' : null}>
          <TimeField label="End" value={end} onChange={setEnd} />
        </Field>
      </View>
      <Field label="Room">
        <Select title="Room" value={roomId} onChange={setRoomId} allowNone="No room" options={rooms.map((r) => ({ value: r.id, label: r.name }))} />
      </Field>
      {past ? <Text variant="small" color={colors.red}>That time has already passed.</Text> : null}
      <Button
        title="Add to draft"
        disabled={bad || past}
        onPress={() =>
          onAdd(
            scope === 'weekly'
              ? { op: 'slot.create', tempId: newTempId(), courseId: course.id, weekday: weekdayOf(date), start, end, roomId }
              : { op: 'extra', tempId: newTempId(), courseId: course.id, date, start, end, roomId },
          )
        }
        style={{ marginTop: 16 }}
      />
    </Sheet>
  );
}

/** Every change in the draft, the clashes it would create, and the publish button. */
function ReviewSheet({
  ops,
  describe,
  conflicts,
  errors,
  title,
  onRename,
  onRemove,
  publish,
  onDiscard,
  onClose,
}: {
  ops: DraftOp[];
  describe: (o: DraftOp) => string;
  conflicts: PlannerConflict[];
  errors: { index: number; message: string }[];
  title: string;
  onRename: (t: string) => void;
  onRemove: (index: number) => void;
  publish: (acceptWarnings: boolean) => Promise<PublishResponse>;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shownConflicts = result && !result.published ? result.conflicts : conflicts;
  const shownErrors = result && !result.published ? result.errors : errors;
  const hard = shownErrors.length > 0 || shownConflicts.some((c) => c.severity === 'error');
  const warnings = shownConflicts.some((c) => c.severity === 'warning');

  async function go(acceptWarnings: boolean) {
    setBusy(true);
    setError(null);
    try {
      setResult(await publish(acceptWarnings));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t publish.');
    } finally {
      setBusy(false);
    }
  }

  if (result?.published)
    return (
      <Sheet open onClose={onClose} title="Published">
        <Notice
          tone="green"
          message={`${result.applied} ${result.applied === 1 ? 'change is' : 'changes are'} live. ${result.notified} ${result.notified === 1 ? 'person was' : 'people were'} notified — students see it on their timetable now.${
            result.requested ? ` ${result.requested} ${result.requested === 1 ? 'teacher was' : 'teachers were'} asked to take a class; those change when they accept (see Requests).` : ''
          }`}
        />
        <Button title="Done" onPress={onClose} style={{ marginTop: 14 }} />
      </Sheet>
    );

  return (
    <Sheet open onClose={onClose} title="Review changes">
      <Field label="Draft name">
        <Input value={title} onChangeText={onRename} maxLength={80} />
      </Field>
      <Text variant="label" style={{ marginTop: 14, marginBottom: 6 }}>
        {ops.length} {ops.length === 1 ? 'change' : 'changes'}
      </Text>
      <View style={{ gap: 6 }}>
        {ops.map((o, i) => {
          const err = shownErrors.find((e) => e.index === i);
          return (
            <View key={i} style={styles.opRow}>
              <Text variant="small" color={err ? colors.red : colors.text} style={{ flex: 1 }}>
                {describe(o)}
                {err ? ` — ${err.message}` : ''}
              </Text>
              <Pressable onPress={() => onRemove(i)} accessibilityRole="button" accessibilityLabel="Remove this change" hitSlop={8}>
                <Text variant="small" color={colors.textDim}>
                  Remove
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
      {shownConflicts.length || shownErrors.length ? (
        <Card tone={hard ? 'red' : 'amber'} style={{ marginTop: 12, gap: 8 }}>
          <Text variant="bodyStrong">{hard ? 'Fix these before publishing' : 'Check these'}</Text>
          <ConflictList conflicts={shownConflicts} errors={[]} />
        </Card>
      ) : (
        <Notice tone="green" message="No clashes: no teacher, room or batch is double-booked." />
      )}
      {error ? <Notice tone="red" message={error} /> : null}
      <Button
        title={warnings && !hard ? 'Publish anyway & notify' : 'Publish & notify'}
        onPress={() => void go(warnings)}
        loading={busy}
        disabled={hard || !ops.length}
        style={{ marginTop: 14 }}
      />
      <Button title="Discard draft" kind="ghost" onPress={onDiscard} style={{ marginTop: 6 }} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  top: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingTop: 6 },
  controls: { paddingHorizontal: 14, paddingVertical: 8, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: 'rgba(8,13,28,0.98)' },
  draftRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  opRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
});
