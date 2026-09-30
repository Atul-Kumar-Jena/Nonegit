import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCheck, Eraser, QrCode, Search } from 'lucide-react-native';
import { ManualBody, randomToken } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Input, Loading, Notice, Segmented, Text } from '@kit/components/ui';
import { ApiRequestError } from '@kit/lib/api-core';
import { outbox, useOutbox } from '@kit/lib/outbox';
import { useApi } from '@kit/state/session';
import { colors, fonts, radius, toneColor } from '@kit/theme';
import { staffApi } from '@/api';
import { Checkbox, Header, Sheet, confirmAction } from '@/components/forms';
import { localSessions } from '@/local-sessions';
import { useFeed } from '@/queries';
import { useSessionView } from '@/session-view';

interface Row {
  userId: string;
  fullName: string;
  rollNo: string | null;
  /** Present on the server when the register opened. */
  wasPresent: boolean;
  scanned: boolean;
}

/**
 * The manual register — for classes without QR, or to fix individual marks.
 * It is deliberately explicit: a warning, a count, and a signed-off
 * "I have checked every name" before anything is saved under the teacher's name.
 */
export default function Register() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = String(rawId ?? '');
  const api = useApi();
  const qc = useQueryClient();
  const navigation = useNavigation();
  const { session: s, roster: packRoster } = useSessionView(id);
  const feed = useFeed(id, false);
  const { items: queued } = useOutbox();

  const [ticks, setTicks] = useState<Set<string> | null>(null);
  /** Roll-call style: everyone starts present and you tap the absentees (or the other way round). */
  // Nobody is ticked until the professor says so: tap who's present (only scans already count).
  const [mode, setMode] = useState<'absent' | 'present'>('present');
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const clientRef = useRef(randomToken(12));
  const saved = useRef(false);

  // A register saved offline for this class and not yet uploaded — start from it.
  const pendingDraft = useMemo(() => {
    const mine = queued.filter((i) => i.kind === 'register' && (i.payload as { sessionId?: string })?.sessionId === id);
    const last = mine[mine.length - 1];
    const parsed = last ? ManualBody.safeParse((last.payload as { body?: unknown }).body) : null;
    return parsed?.success ? parsed.data : null;
  }, [queued, id]);

  const rows: Row[] | null = useMemo(() => {
    if (feed.data)
      return feed.data.entries.map((e) => ({ userId: e.userId, fullName: e.fullName, rollNo: e.rollNo, wasPresent: e.present, scanned: e.present && e.source === 'scan' }));
    if (packRoster) return packRoster.map((r) => ({ userId: r.userId, fullName: r.fullName, rollNo: r.rollNo, wasPresent: false, scanned: false }));
    return null;
  }, [feed.data, packRoster]);
  const sortedRows = useMemo(
    () => (rows ? [...rows].sort((a, b) => (a.rollNo ?? '~').localeCompare(b.rollNo ?? '~', undefined, { numeric: true }) || a.fullName.localeCompare(b.fullName)) : null),
    [rows],
  );

  useEffect(() => {
    if (ticks || !rows) return;
    const already = rows.filter((r) => r.wasPresent).map((r) => r.userId);
    // Only those already present (scanned or marked before) start ticked — never everyone.
    setTicks(new Set(pendingDraft ? pendingDraft.present : already));
  }, [rows, ticks, pendingDraft]);

  const offlineMode = !feed.data && !!packRoster;
  const dirty = !!ticks && !!rows && rows.some((r) => ticks.has(r.userId) !== r.wasPresent);
  const removedScans = rows && ticks ? rows.filter((r) => r.scanned && !ticks.has(r.userId)) : [];
  const needsNote = removedScans.length > 0 && note.trim().length < 3;

  // Don't lose a half-taken register to an accidental back swipe.
  useEffect(() => {
    return navigation.addListener('beforeRemove', (e) => {
      if (!dirty || saved.current) return;
      e.preventDefault();
      confirmAction('Discard this register?', 'Your ticks haven’t been saved.', 'Discard', () => navigation.dispatch(e.data.action), true);
    });
  }, [navigation, dirty]);

  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t && sortedRows ? sortedRows.filter((r) => `${r.fullName} ${r.rollNo ?? ''}`.toLowerCase().includes(t)) : sortedRows ?? [];
  }, [sortedRows, q]);

  function toggle(uid: string) {
    setTicks((cur) => {
      const n = new Set(cur ?? []);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
    setChecked(false);
  }

  async function save() {
    if (!rows || !ticks || !s) return;
    setBusy(true);
    setError(null);
    const body: ManualBody = {
      clientRef: clientRef.current,
      recordedAt: api.serverNow(),
      present: rows.filter((r) => ticks.has(r.userId)).map((r) => r.userId),
      // Only explicit removals are sent as absent: a student who scans while the register is
      // open is never wiped out by it (and an offline register can only add people).
      absent: rows.filter((r) => r.wasPresent && !ticks.has(r.userId)).map((r) => r.userId),
      note: note.trim() || null,
      confirmed: true,
    };
    try {
      const res = await staffApi.register(api, id, body);
      saved.current = true;
      void qc.invalidateQueries({ queryKey: ['staff'] });
      router.back();
      void res;
    } catch (err) {
      if (err instanceof ApiRequestError && (err.code === 'NETWORK' || err.code === 'TIMEOUT' || err.status >= 500)) {
        await outbox.enqueue('register', `${s.courseCode} · register (${body.present.length} present)`, { sessionId: id, body });
        if (s.status === 'scheduled')
          await localSessions.put({
            sessionId: id,
            status: 'closed',
            mode: 'manual',
            startedAt: Date.parse(s.scheduledStart),
            endedAt: Date.parse(s.scheduledEnd),
            rotationS: s.rotationS,
            secret: null,
            courseCode: s.courseCode,
            courseTitle: s.courseTitle,
          });
        saved.current = true;
        router.back();
      } else {
        setError(err instanceof Error ? err.message : 'Couldn’t save the register.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!s || !sortedRows || !ticks) {
    return (
      <Screen scroll={false}>
        <Header title="Register" />
        {feed.isPending && !packRoster ? <Loading /> : <Notice tone="amber" message="The class list isn’t on this phone. Connect to the internet once to download it." />}
      </Screen>
    );
  }

  const presentCount = ticks.size;
  const total = rows!.length;

  return (
    <Screen scroll={false}>
      <Header info="register" title="Register" subtitle={`${s.courseCode} · ${s.courseTitle}`} />
      <View style={styles.warning}>
        <AlertTriangle color={colors.amber} size={14} />
        <Text variant="small" style={{ flex: 1 }}>
          Saved under your name and audited — mark only who you can see.
        </Text>
      </View>
      <Segmented
        value={mode}
        onChange={(m) => {
          setMode(m);
          setChecked(false);
          // Switching to roll-call on an untouched register: start with everyone present.
          if (m === 'absent' && ticks && ticks.size === 0 && rows) setTicks(new Set(rows.map((r) => r.userId)));
        }}
        options={[
          { value: 'absent', label: 'Tap who’s absent' },
          { value: 'present', label: 'Tap who’s present' },
        ]}
      />
      {offlineMode ? (
        <View style={{ marginTop: 8 }}>
          <Notice tone="violet" message="Offline — saved on the phone and uploaded automatically. Students who scanned stay marked." />
        </View>
      ) : null}
      {pendingDraft ? (
        <View style={{ marginTop: 8 }}>
          <Notice tone="violet" message="A register for this class is waiting to upload. Saving again replaces it." />
        </View>
      ) : null}

      <View style={styles.tools}>
        <View style={{ flex: 1 }}>
          <Input value={q} onChangeText={setQ} placeholder="Search name or roll no." icon={<Search color={colors.textDim} size={16} />} autoCorrect={false} />
        </View>
        <Pressable
          onPress={() =>
            confirmAction('Mark everyone present?', `All ${total} students will be ticked. Untick anyone who isn’t in class.`, 'Tick all', () => {
              setTicks(new Set(rows!.map((r) => r.userId)));
              setChecked(false);
            })
          }
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Mark everyone present"
        >
          <CheckCheck color={colors.text} size={18} />
        </Pressable>
        <Pressable
          onPress={() => {
            setTicks(new Set());
            setChecked(false);
          }}
          style={styles.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Clear all ticks"
        >
          <Eraser color={colors.textMuted} size={18} />
        </Pressable>
      </View>

      <FlatList
        style={{ flex: 1, marginTop: 10 }}
        contentContainerStyle={{ paddingBottom: 16 }}
        data={visible}
        keyExtractor={(r) => r.userId}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={30}
        showsVerticalScrollIndicator
        persistentScrollbar
        renderItem={({ item }) => {
          const on = ticks.has(item.userId);
          const changed = on !== item.wasPresent;
          return (
            <Pressable
              onPress={() => toggle(item.userId)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${item.fullName}${item.rollNo ? `, ${item.rollNo}` : ''}`}
              style={[
                styles.row,
                mode === 'present' && on && { backgroundColor: toneColor.green.bg },
                mode === 'absent' && !on && { backgroundColor: toneColor.red.bg, borderColor: toneColor.red.line },
                changed && mode === 'present' && { borderColor: toneColor.amber.line },
              ]}
            >
              <Checkbox checked={on} tone="green" />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {item.fullName}
                </Text>
                <Text variant="monoSmall">{item.rollNo ?? 'no roll no.'}</Text>
              </View>
              {item.scanned ? <Badge label="Scanned" tone="cyan" icon={<QrCode color={colors.cyan} size={10} />} /> : null}
              {!on ? <Badge label="Absent" tone="red" dot={false} /> : changed ? <Badge label="Present" tone="green" dot={false} /> : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text variant="small" style={{ padding: 16 }}>{total === 0 ? 'No students are enrolled in this course yet.' : 'No one matches.'}</Text>}
      />

      {/* A slim bar: the list keeps the screen; the note and the final check open in a sheet. */}
      <View style={styles.bar}>
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">
            <Text style={{ color: colors.green, fontFamily: fonts.bold }}>{presentCount}</Text> present
          </Text>
          <Text variant="small">{`${total - presentCount} absent · ${total} in class`}</Text>
        </View>
        <Button title="Review & save" onPress={() => setReview(true)} disabled={total === 0} compact />
      </View>

      <Sheet open={review} onClose={() => setReview(false)} title="Save the register" scroll>
        <View style={{ gap: 12, paddingBottom: 8 }}>
          <Text variant="body">{`${presentCount} present, ${total - presentCount} absent${removedScans.length ? ` · ${removedScans.length} QR ${removedScans.length === 1 ? 'mark' : 'marks'} removed` : ''}.`}</Text>
          {removedScans.length ? (
            <Text variant="small" color={colors.amber}>
              You’re removing {removedScans.length} {removedScans.length === 1 ? 'mark' : 'marks'} made by QR scan. Say why (required):
            </Text>
          ) : null}
          <Input value={note} onChangeText={setNote} placeholder={removedScans.length ? 'e.g. left after 10 minutes' : 'Note (optional)'} maxLength={300} invalid={needsNote} />
          <Pressable onPress={() => setChecked((c) => !c)} accessibilityRole="checkbox" accessibilityState={{ checked }} style={styles.confirm}>
            <Checkbox checked={checked} tone="amber" />
            <Text variant="small" color={colors.text} style={{ flex: 1 }}>
              I have checked every name. {presentCount} present, {total - presentCount} absent is correct.
            </Text>
          </Pressable>
          {error ? <Notice tone="red" message={error} /> : null}
          <Button title={offlineMode ? 'Save on phone' : 'Save register'} onPress={() => void save()} loading={busy} disabled={!checked || needsNote || total === 0} />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  warning: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  iconBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 16, marginBottom: 8, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  confirm: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
