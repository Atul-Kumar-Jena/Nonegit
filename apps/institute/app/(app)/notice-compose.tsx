import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Bold, Heading1, Heading2, Italic, Link2, List, ListOrdered, Minus, Quote, Send, Strikethrough } from 'lucide-react-native';
import { NOTICE_CATEGORIES, type NoticeAudience, type NoticeCategory } from '@attendly/protocol';
import { CategoryPill, useNotice } from '@kit/components/Notices';
import { RichText } from '@kit/components/RichText';
import { Screen } from '@kit/components/Screen';
import { Button, Card, Input, Notice, SectionLabel, Segmented, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors, fonts, radius } from '@kit/theme';
import { batchChip } from '@/batches';
import { Checkbox, Header, ToggleRow } from '@/components/forms';
import { useBatches, useCan, useCourses } from '@/queries';

type Kind = NoticeAudience['kind'];
const KIND_LABEL: Record<Kind, string> = { everyone: 'Everyone', students: 'All students', staff: 'All faculty', batches: 'Batches', courses: 'Subjects' };

/** Write (or edit) a notice: audience, topic, title, formatted text with a live preview. */
export default function NoticeCompose() {
  const { id: editId } = useLocalSearchParams<{ id?: string }>();
  const editing = !!editId;
  const api = useApi();
  const qc = useQueryClient();
  const broadcast = useCan('broadcast');
  const batches = useBatches();
  const courses = useCourses();
  const existing = useNotice(String(editId ?? ''));

  const [kind, setKind] = useState<Kind>('batches');
  const [batchIds, setBatchIds] = useState<Set<string>>(new Set());
  const [courseIds, setCourseIds] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<NoticeCategory>('general');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [important, setImportant] = useState(false);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [sel, setSel] = useState({ start: 0, end: 0 });
  /** Set only when a toolbar button moves the cursor (a controlled cursor while typing lags on Android). */
  const [forced, setForced] = useState<{ start: number; end: number } | undefined>(undefined);
  const moveTo = (s: { start: number; end: number }) => {
    setSel(s);
    setForced(s);
  };
  const [count, setCount] = useState<{ recipients: number; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<TextInput>(null);

  // Editing: load the notice once.
  useEffect(() => {
    const n = existing.data;
    if (!n || !editing) return;
    setTitle(n.title);
    setBody(n.body);
    setCategory(n.category);
    setPinned(n.pinned);
    setImportant(n.important);
  }, [existing.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const audience: NoticeAudience | null = useMemo(() => {
    if (kind === 'batches') return batchIds.size ? { kind, batchIds: [...batchIds] } : null;
    if (kind === 'courses') return courseIds.size ? { kind, courseIds: [...courseIds] } : null;
    return { kind };
  }, [kind, batchIds, courseIds]);

  // "Will reach N people"
  useEffect(() => {
    if (editing || !audience) {
      setCount(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .noticeAudience(audience)
        .then((r) => live && setCount(r))
        .catch(() => live && setCount(null));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [JSON.stringify(audience), editing]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── formatting toolbar ──
  function wrap(mark: string, placeholder: string) {
    const { start, end } = sel;
    const inner = body.slice(start, end) || placeholder;
    const next = `${body.slice(0, start)}${mark}${inner}${mark}${body.slice(end)}`;
    setBody(next);
    const s = start + mark.length;
    moveTo({ start: s, end: s + inner.length });
    input.current?.focus();
  }
  function linePrefix(prefix: string) {
    const lineStart = body.lastIndexOf('\n', Math.max(0, sel.start - 1)) + 1;
    const line = body.slice(lineStart);
    // Toggle: tapping again removes it.
    const next = line.startsWith(prefix) ? body.slice(0, lineStart) + line.slice(prefix.length) : body.slice(0, lineStart) + prefix + line;
    setBody(next);
    input.current?.focus();
  }
  function insert(text: string) {
    const { start, end } = sel;
    setBody(`${body.slice(0, start)}${text}${body.slice(end)}`);
    input.current?.focus();
  }
  function link() {
    const { start, end } = sel;
    const label = body.slice(start, end) || 'link text';
    const text = `[${label}](https://)`;
    setBody(`${body.slice(0, start)}${text}${body.slice(end)}`);
    const urlAt = start + label.length + 3;
    moveTo({ start: urlAt + 8, end: urlAt + 8 });
    input.current?.focus();
  }

  const tools = [
    { icon: Bold, label: 'Bold', run: () => wrap('**', 'bold') },
    { icon: Italic, label: 'Italic', run: () => wrap('*', 'italic') },
    { icon: Strikethrough, label: 'Strikethrough', run: () => wrap('~~', 'text') },
    { icon: Heading1, label: 'Heading', run: () => linePrefix('# ') },
    { icon: Heading2, label: 'Small heading', run: () => linePrefix('## ') },
    { icon: List, label: 'Bullet list', run: () => linePrefix('- ') },
    { icon: ListOrdered, label: 'Numbered list', run: () => linePrefix('1. ') },
    { icon: Quote, label: 'Quote', run: () => linePrefix('> ') },
    { icon: Link2, label: 'Link', run: link },
    { icon: Minus, label: 'Divider', run: () => insert('\n---\n') },
  ];

  async function send() {
    if (busy) return;
    setError(null);
    if (!title.trim()) return setError('Add a title.');
    if (!body.trim()) return setError('Write the notice.');
    if (!editing && !audience) return setError(kind === 'batches' ? 'Pick at least one batch.' : 'Pick at least one subject.');
    setBusy(true);
    try {
      const n = editing
        ? await api.editNotice(String(editId), { title: title.trim(), body: body.trim(), category, pinned, important })
        : await api.sendNotice({ title: title.trim(), body: body.trim(), category, audience: audience!, pinned, important });
      void qc.invalidateQueries({ queryKey: ['notices'] });
      qc.setQueryData(['notice', n.id], n);
      router.replace({ pathname: '/notice/[id]', params: { id: n.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t send.');
    } finally {
      setBusy(false);
    }
  }

  const kinds: Kind[] = broadcast ? ['everyone', 'students', 'staff', 'batches', 'courses'] : ['batches', 'courses'];
  const toggleIn = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };

  return (
    <Screen keyboard>
      <Header title={editing ? 'Edit notice' : 'New notice'} info="notices" />

      {!editing ? (
        <>
          <SectionLabel>Send to</SectionLabel>
          <View style={styles.wrap}>
            {kinds.map((k) => (
              <Pressable key={k} onPress={() => setKind(k)} accessibilityRole="radio" accessibilityState={{ selected: kind === k }} style={[styles.chip, kind === k && styles.chipOn]}>
                <Text style={[styles.chipText, kind === k && { color: colors.bg }]}>{KIND_LABEL[k]}</Text>
              </Pressable>
            ))}
          </View>
          {kind === 'batches' ? (
            <View style={[styles.wrap, { marginTop: 10 }]}>
              {(batches.data ?? []).filter((b) => b.active).length === 0 ? (
                <Text variant="small">No batches yet — create one in Classes → Batches.</Text>
              ) : (
                (batches.data ?? [])
                  .filter((b) => b.active)
                  .map((b) => {
                    const on = batchIds.has(b.id);
                    return (
                      <Pressable key={b.id} onPress={() => setBatchIds(toggleIn(batchIds, b.id))} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={[styles.pick, on && styles.pickOn]}>
                        <Checkbox checked={on} size={18} />
                        <Text style={styles.pickText}>{batchChip(b)}</Text>
                      </Pressable>
                    );
                  })
              )}
            </View>
          ) : null}
          {kind === 'courses' ? (
            <View style={[styles.wrap, { marginTop: 10 }]}>
              {(courses.data ?? []).filter((c) => c.active).length === 0 ? (
                <Text variant="small">You don’t teach any subject yet.</Text>
              ) : (
                (courses.data ?? [])
                  .filter((c) => c.active)
                  .map((c) => {
                    const on = courseIds.has(c.id);
                    return (
                      <Pressable key={c.id} onPress={() => setCourseIds(toggleIn(courseIds, c.id))} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={[styles.pick, on && styles.pickOn]}>
                        <Checkbox checked={on} size={18} />
                        <Text style={styles.pickText}>{c.code}</Text>
                      </Pressable>
                    );
                  })
              )}
            </View>
          ) : null}
          <Text variant="small" style={{ marginTop: 10 }}>
            {count ? `Reaches ${count.recipients} ${count.recipients === 1 ? 'person' : 'people'} · ${count.label}` : audience ? 'Counting…' : ' '}
          </Text>
          {!broadcast ? <Text variant="small">To send to everyone, all students or all faculty, ask an admin for “Notices to everyone”.</Text> : null}
        </>
      ) : existing.data ? (
        <Text variant="small" style={{ marginTop: 6 }}>{`To ${existing.data.audienceLabel} (the audience can’t change after sending)`}</Text>
      ) : null}

      <SectionLabel>Topic</SectionLabel>
      <View style={styles.wrap}>
        {NOTICE_CATEGORIES.map((c) => (
          <Pressable key={c.key} onPress={() => setCategory(c.key)} accessibilityRole="radio" accessibilityState={{ selected: category === c.key }} style={[styles.chip, category === c.key && styles.chipOn]}>
            <Text style={[styles.chipText, category === c.key && { color: colors.bg }]}>{`${c.emoji} ${c.label}`}</Text>
          </Pressable>
        ))}
      </View>

      <SectionLabel>Title</SectionLabel>
      <Input value={title} onChangeText={setTitle} placeholder="e.g. Mid-term exam schedule" maxLength={120} accessibilityLabel="Title" />

      <View style={{ marginTop: 18 }}>
        <Segmented
          value={mode}
          options={[
            { value: 'write', label: 'Write' },
            { value: 'preview', label: 'Preview' },
          ]}
          onChange={setMode}
        />
      </View>

      {mode === 'write' ? (
        <View style={styles.editor}>
          <View style={styles.toolbar}>
            {tools.map((t) => (
              <Pressable key={t.label} onPress={t.run} accessibilityRole="button" accessibilityLabel={t.label} hitSlop={4} style={({ pressed }) => [styles.tool, pressed && { backgroundColor: colors.bgRaised }]}>
                <t.icon color={colors.text} size={18} />
              </Pressable>
            ))}
          </View>
          <TextInput
            ref={input}
            value={body}
            onChangeText={setBody}
            selection={forced}
            onSelectionChange={(e) => {
              setSel(e.nativeEvent.selection);
              if (forced) setForced(undefined);
            }}
            multiline
            placeholder={'Write your notice…\n\nSelect words and tap B / I to style them.\nStart a line with - for a list.'}
            placeholderTextColor={colors.textDim}
            style={styles.area}
            textAlignVertical="top"
            maxLength={5000}
            accessibilityLabel="Notice text"
          />
          <Text variant="monoSmall" style={{ alignSelf: 'flex-end', padding: 8 }}>{`${body.length} / 5000`}</Text>
        </View>
      ) : (
        <Card style={[{ marginTop: 12, gap: 10 }, important && { borderColor: 'rgba(248,113,113,0.5)' }]}>
          <CategoryPill category={category} important={important} />
          <Text style={styles.previewTitle}>{title || 'Title'}</Text>
          {body.trim() ? <RichText source={body} /> : <Text variant="small">Nothing written yet.</Text>}
        </Card>
      )}

      <View style={{ marginTop: 16, gap: 10 }}>
        <ToggleRow label="📌 Pin to the top" hint="Stays above other notices until you unpin it." value={pinned} onChange={setPinned} />
        <ToggleRow label="⚠️ Important" hint="Highlighted in red; the notification says “Important”." value={important} onChange={setImportant} />
      </View>

      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} onDismiss={() => setError(null)} />
        </View>
      ) : null}
      <Button
        title={editing ? 'Save changes' : count ? `Send to ${count.recipients} ${count.recipients === 1 ? 'person' : 'people'}` : 'Send'}
        onPress={() => void send()}
        loading={busy}
        disabled={!title.trim() || !body.trim() || (!editing && !audience)}
        icon={<Send color={colors.bg} size={16} />}
        style={{ marginTop: 18 }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontFamily: fonts.medium, fontSize: 14, color: colors.text },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  pickOn: { borderColor: colors.text },
  pickText: { fontFamily: fonts.medium, fontSize: 14, color: colors.text },
  editor: { marginTop: 12, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, overflow: 'hidden' },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 2, padding: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tool: { width: 38, height: 38, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  area: { minHeight: 220, maxHeight: 420, padding: 14, color: colors.text, fontFamily: fonts.regular, fontSize: 16, lineHeight: 24 },
  previewTitle: { fontFamily: fonts.bold, fontSize: 22, lineHeight: 28, letterSpacing: -0.4, color: colors.text },
});
