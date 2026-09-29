import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Megaphone, Pin, SmilePlus, TriangleAlert } from 'lucide-react-native';
import { NOTICE_CATEGORIES, NOTICE_REACTIONS, type NoticeCategory, type NoticeDetail, type NoticeSummary, type NoticesResponse } from '@attendly/protocol';
import { timeAgo } from '../lib/format';
import { useApi } from '../state/session';
import { colors, fonts, radius } from '../theme';
import { Avatar, Card, Text } from './ui';

export type NoticeFilter = 'all' | 'unread' | 'pinned' | 'mine';
export const noticeKeys = {
  list: (filter: NoticeFilter, category?: NoticeCategory) => ['notices', filter, category ?? 'any'] as const,
  one: (id: string) => ['notice', id] as const,
};

export const categoryOf = (k: NoticeCategory) => NOTICE_CATEGORIES.find((c) => c.key === k) ?? NOTICE_CATEGORIES[0]!;
const initialsOf = (name: string) =>
  name
    .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export function useNotices(filter: NoticeFilter, category?: NoticeCategory) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: noticeKeys.list(filter, category),
    queryFn: ({ pageParam }) => api.notices({ filter, category, before: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: NoticesResponse) => last.nextBefore,
    refetchInterval: 30_000,
  });
}

/** Unread notices, for badges and the Home card (refreshes every 30 s). */
export function useNoticeInbox() {
  const api = useApi();
  return useQuery({ queryKey: ['notices', 'inbox'], queryFn: () => api.notices({ filter: 'all' }), refetchInterval: 30_000 });
}

export function useNotice(id: string) {
  const api = useApi();
  return useQuery({ queryKey: noticeKeys.one(id), queryFn: () => api.notice(id), enabled: /^[0-9a-f-]{36}$/i.test(id) });
}

/** "📝 Exam" pill. */
export function CategoryPill({ category, important }: { category: NoticeCategory; important?: boolean }) {
  const c = categoryOf(category);
  return (
    <View style={styles.pillRow}>
      <View style={styles.pill}>
        <Text style={styles.pillText}>{`${c.emoji}  ${c.label}`}</Text>
      </View>
      {important ? (
        <View style={[styles.pill, styles.pillImportant]}>
          <TriangleAlert color={colors.red} size={12} />
          <Text style={[styles.pillText, { color: colors.red }]}>Important</Text>
        </View>
      ) : null}
    </View>
  );
}

/** One notice in a list: category, title, 2-line preview, author, audience, reactions. */
export function NoticeCard({ n }: { n: NoticeSummary }) {
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/notice/[id]', params: { id: n.id } } as never)}
      accessibilityRole="button"
      accessibilityLabel={`${n.read ? '' : 'Unread. '}${n.title}, from ${n.author.name}`}
      style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}
    >
      <Card style={[styles.card, n.important && styles.cardImportant, !n.read && styles.cardUnread]}>
        <View style={styles.cardTop}>
          <CategoryPill category={n.category} important={n.important} />
          <View style={{ flex: 1 }} />
          {n.pinned ? <Pin color={colors.textMuted} size={14} /> : null}
          {!n.read ? <View style={styles.dot} /> : null}
        </View>
        <Text style={[styles.title, !n.read && { fontFamily: fonts.bold }]} numberOfLines={2}>
          {n.title}
        </Text>
        <Text variant="small" numberOfLines={2} style={{ marginTop: 4 }}>
          {n.preview}
        </Text>
        <View style={styles.meta}>
          <Avatar text={initialsOf(n.author.name)} size={24} />
          <Text variant="small" numberOfLines={1} style={{ flex: 1 }}>
            {`${n.author.name} · ${n.author.role} · to ${n.audienceLabel}`}
          </Text>
          <Text variant="monoSmall">{timeAgo(n.createdAt)}</Text>
        </View>
        {n.reactions.length ? (
          <View style={styles.reactRow}>
            {n.reactions.map((r) => (
              <View key={r.emoji} style={[styles.reactChipSmall, r.mine && styles.reactMine]}>
                <Text style={{ fontSize: 13 }}>{`${r.emoji} ${r.count}`}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

/** Reactions on a notice: existing ones as chips (tap = add / remove yours), + to pick another. */
export function ReactionBar({ n }: { n: NoticeDetail }) {
  const api = useApi();
  const qc = useQueryClient();
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  async function toggle(emoji: string) {
    if (busy) return;
    setBusy(true);
    setPicker(false);
    // Optimistic: flip it at once, then take the server's numbers.
    const optimistic = (() => {
      const cur = n.reactions.find((r) => r.emoji === emoji);
      if (cur?.mine) return n.reactions.map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, mine: false } : r)).filter((r) => r.count > 0);
      if (cur) return n.reactions.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, mine: true } : r));
      return [...n.reactions, { emoji: emoji as NoticeDetail['reactions'][number]['emoji'], count: 1, mine: true }];
    })();
    qc.setQueryData<NoticeDetail>(noticeKeys.one(n.id), (old) => (old ? { ...old, reactions: optimistic } : old));
    try {
      const reactions = await api.reactToNotice(n.id, emoji);
      qc.setQueryData<NoticeDetail>(noticeKeys.one(n.id), (old) => (old ? { ...old, reactions } : old));
      void qc.invalidateQueries({ queryKey: ['notices'] });
    } catch {
      qc.setQueryData<NoticeDetail>(noticeKeys.one(n.id), (old) => (old ? { ...old, reactions: n.reactions } : old));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View>
      <View style={styles.reactRow}>
        {n.reactions.map((r) => (
          <Pressable key={r.emoji} onPress={() => void toggle(r.emoji)} accessibilityRole="button" accessibilityState={{ selected: r.mine }} accessibilityLabel={`${r.emoji} ${r.count}${r.mine ? ', yours' : ''}`} style={[styles.reactChip, r.mine && styles.reactMine]}>
            <Text style={{ fontSize: 17 }}>{r.emoji}</Text>
            <Text style={[styles.reactCount, r.mine && { color: colors.text }]}>{r.count}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setPicker(!picker)} accessibilityRole="button" accessibilityLabel="Add a reaction" style={styles.reactChip}>
          <SmilePlus color={colors.textMuted} size={18} />
        </Pressable>
      </View>
      {picker ? (
        <View style={styles.picker}>
          {NOTICE_REACTIONS.map((e) => {
            const mine = n.reactions.some((r) => r.emoji === e && r.mine);
            return (
              <Pressable key={e} onPress={() => void toggle(e)} accessibilityRole="button" accessibilityLabel={`React ${e}`} style={[styles.pickItem, mine && styles.reactMine]}>
                <Text style={{ fontSize: 26 }}>{e}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Home: the notice board, always visible — a swipeable strip of the latest notices (pinned first,
 * unread marked, important in red), each opening its full text, plus a link to the Notice centre.
 */
export function NoticeHomeCard({ canPost = false }: { canPost?: boolean }) {
  const q = useNoticeInbox();
  const d = q.data;
  if (!d) return null;
  const seen = new Set<string>();
  const list = [...d.pinned, ...d.items].filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true))).slice(0, 8);
  return (
    <View style={{ marginTop: 18 }}>
      <View style={styles.homeHead}>
        <Megaphone color={colors.text} size={16} />
        <Text variant="label" style={{ flex: 1 }}>
          {d.unread ? `Notices · ${d.unread} new` : 'Notices'}
        </Text>
        {canPost ? (
          <Pressable onPress={() => router.push('/notice-compose' as never)} accessibilityRole="button" hitSlop={8} style={styles.homeAction}>
            <Text variant="small" color={colors.text}>
              + New
            </Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => router.push('/notices' as never)} accessibilityRole="button" hitSlop={8} style={styles.homeAction}>
          <Text variant="small" color={colors.text}>
            All
          </Text>
          <ChevronRight color={colors.textDim} size={16} />
        </Pressable>
      </View>
      {list.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 8 }} style={{ marginHorizontal: -2 }}>
          {list.map((n) => (
            <Pressable
              key={n.id}
              onPress={() => router.push({ pathname: '/notice/[id]', params: { id: n.id } } as never)}
              accessibilityRole="button"
              accessibilityLabel={`${n.read ? '' : 'Unread. '}${n.important ? 'Important. ' : ''}${n.title}`}
              style={({ pressed }) => [styles.strip, n.important && styles.cardImportant, !n.read && styles.cardUnread, pressed && { opacity: 0.85 }]}
            >
              <View style={styles.cardTop}>
                <CategoryPill category={n.category} important={n.important} />
                <View style={{ flex: 1 }} />
                {n.pinned ? <Pin color={colors.textMuted} size={13} /> : null}
                {!n.read ? <View style={styles.dot} /> : null}
              </View>
              <Text style={[styles.title, { fontSize: 15 }, !n.read && { fontFamily: fonts.bold }]} numberOfLines={2}>
                {n.title}
              </Text>
              <Text variant="small" numberOfLines={3} style={{ marginTop: 4, flex: 1 }}>
                {n.preview}
              </Text>
              <Text variant="monoSmall" numberOfLines={1} style={{ marginTop: 8 }}>
                {`${n.author.name} · ${timeAgo(n.createdAt)}`}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <Text variant="small">No notices yet.</Text>
      )}
    </View>
  );
}

/** Horizontal filter chips. */
export function ChipRow<T extends string>({ value, options, onChange }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator persistentScrollbar indicatorStyle="white" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]}>
            <Text style={[styles.chipText, on && { color: colors.bg }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { gap: 2 },
  cardUnread: { borderColor: colors.borderHi },
  cardImportant: { borderColor: 'rgba(248,113,113,0.55)' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.text },
  title: { fontFamily: fonts.semibold, fontSize: 17, lineHeight: 23, color: colors.text, letterSpacing: -0.2 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  pillRow: { flexDirection: 'row', gap: 6 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: colors.bgRaised, borderWidth: 1, borderColor: colors.border },
  pillImportant: { borderColor: 'rgba(248,113,113,0.5)', backgroundColor: 'rgba(248,113,113,0.08)' },
  pillText: { fontFamily: fonts.medium, fontSize: 12, color: colors.textMuted },
  reactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  reactChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 38, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised },
  reactChipSmall: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  reactMine: { borderColor: colors.text, backgroundColor: 'rgba(255,255,255,0.1)' },
  reactCount: { fontFamily: fonts.semibold, fontSize: 14, color: colors.textMuted },
  picker: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, padding: 8, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  pickItem: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' },
  strip: { width: 250, minHeight: 150, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  homeAction: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 6, paddingVertical: 4 },
  homeHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  chipOn: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontFamily: fonts.medium, fontSize: 13.5, color: colors.text },
});
