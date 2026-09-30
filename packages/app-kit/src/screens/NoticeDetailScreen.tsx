import { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Eye, Pencil, Pin, Search, Trash2, Users } from 'lucide-react-native';
import type { NoticeReader } from '@attendly/protocol';
import { CategoryPill, ReactionBar, useNotice } from '../components/Notices';
import { RichText } from '../components/RichText';
import { Screen } from '../components/Screen';
import { Avatar, Button, Card, Divider, ErrorState, IconButton, Input, Loading, ProgressBar, Segmented, Text } from '../components/ui';
import { dateLong, clock } from '../lib/format';
import { useApi } from '../state/session';
import { colors, fonts } from '../theme';

const initialsOf = (name: string) =>
  name
    .replace(/^(dr|prof|mr|mrs|ms)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

/** One notice: formatted body, who sent it to whom, reactions; author/admin: seen-by, edit, delete. */
export default function NoticeDetailScreen() {
  const { id: raw } = useLocalSearchParams<{ id: string }>();
  const id = String(raw ?? '');
  const api = useApi();
  const qc = useQueryClient();
  const q = useNotice(id);

  // Opening it marked it read on the server: refresh the lists and badges.
  useEffect(() => {
    if (q.data) void qc.invalidateQueries({ queryKey: ['notices'] });
  }, [q.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = (
    <IconButton label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/notices' as never))}>
      <ArrowLeft color={colors.text} size={18} />
    </IconButton>
  );
  if (q.isPending) return <Screen scroll={false}>{back}<Loading /></Screen>;
  if (!q.data)
    return (
      <Screen>
        {back}
        <View style={{ marginTop: 24 }}>
          <ErrorState message={q.error?.message ?? 'Not found.'} onRetry={() => void q.refetch()} />
        </View>
      </Screen>
    );
  const n = q.data;

  function remove() {
    const run = () =>
      void api
        .deleteNotice(n.id)
        .then(() => qc.invalidateQueries({ queryKey: ['notices'] }))
        .then(() => (router.canGoBack() ? router.back() : router.replace('/notices' as never)))
        .catch((e: Error) => Alert.alert('Couldn’t delete', e.message));
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.('Delete this notice for everyone?')) run();
      return;
    }
    Alert.alert('Delete this notice?', 'It disappears for everyone it was sent to.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: run },
    ]);
  }

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {back}
        <View style={{ flex: 1 }} />
        {n.pinned ? <Pin color={colors.textMuted} size={16} /> : null}
      </View>

      <View style={{ marginTop: 18 }}>
        <CategoryPill category={n.category} important={n.important} />
      </View>
      <Text style={styles.title}>{n.title}</Text>

      <View style={styles.byline}>
        <Avatar text={initialsOf(n.author.name)} size={36} />
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">{n.author.name}</Text>
          <Text variant="small">{`${n.author.role} · ${dateLong(n.createdAt)}, ${clock(n.createdAt)}${n.editedAt ? ' · edited' : ''}`}</Text>
        </View>
      </View>
      <View style={styles.to}>
        <Users color={colors.textMuted} size={14} />
        <Text variant="small">{`To ${n.audienceLabel}`}</Text>
      </View>

      <Card style={[styles.bodyCard, n.important && { borderColor: 'rgba(248,113,113,0.5)' }]}>
        <RichText source={n.body} />
      </Card>

      <ReactionBar n={n} />

      {n.stats ? (
        <Card style={{ marginTop: 18, gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Eye color={colors.text} size={16} />
            <Text variant="bodyStrong" style={{ flex: 1 }}>{`Seen by ${n.stats.seen} of ${n.stats.recipients}`}</Text>
            <Text variant="small">{n.stats.recipients ? `${Math.round((n.stats.seen / n.stats.recipients) * 100)}%` : '—'}</Text>
          </View>
          <ProgressBar value={n.stats.recipients ? (n.stats.seen / n.stats.recipients) * 100 : 0} height={5} />
          <Readers id={n.id} seenCount={n.stats.seen} />
        </Card>
      ) : null}

      {n.canEdit ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <Button title="Edit" kind="secondary" compact onPress={() => router.push({ pathname: '/notice-compose', params: { id: n.id } } as never)} icon={<Pencil color={colors.text} size={15} />} style={{ flex: 1 }} />
          <Button title="Delete" kind="danger" compact onPress={remove} icon={<Trash2 color={colors.red} size={15} />} style={{ flex: 1 }} />
        </View>
      ) : null}
    </Screen>
  );
}

const ROLE: Record<NoticeReader['role'], string> = { student: 'Student', teacher: 'Professor', admin: 'Admin' };
const PAGE = 30;

/** Exactly who has seen the notice (latest first) and who hasn't yet — searchable. */
function Readers({ id, seenCount }: { id: string; seenCount: number }) {
  const api = useApi();
  const [tab, setTab] = useState<'seen' | 'notSeen'>('seen');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  // Refetch when the count moves (someone else opened it since).
  const q = useQuery({ queryKey: ['notices', 'readers', id, seenCount], queryFn: () => api.noticeReaders(id), staleTime: 15_000 });
  const list = useMemo(() => {
    const all = q.data?.[tab] ?? [];
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((r) => r.name.toLowerCase().includes(needle) || (r.rollNo ?? '').toLowerCase().includes(needle)) : all;
  }, [q.data, tab, query]);
  if (q.isLoading) return <Loading label="Loading who has seen it…" />;
  if (q.error || !q.data) return <Text variant="small">Couldn’t load the list. Pull to refresh.</Text>;
  const total = q.data.seen.length + q.data.notSeen.length;
  return (
    <View style={{ gap: 10, marginTop: 4 }}>
      <Segmented
        value={tab}
        onChange={(v) => {
          setTab(v);
          setShown(PAGE);
        }}
        options={[
          { value: 'seen', label: `Seen · ${q.data.seen.length}` },
          { value: 'notSeen', label: `Not yet · ${q.data.notSeen.length}` },
        ]}
      />
      {total > 8 ? (
        <Input value={query} onChangeText={setQuery} placeholder="Search name or roll no." icon={<Search color={colors.textMuted} size={16} />} accessibilityLabel="Search readers" autoCorrect={false} />
      ) : null}
      {list.length === 0 ? (
        <Text variant="small" style={{ paddingVertical: 6 }}>
          {query ? 'Nobody matches.' : tab === 'seen' ? 'Nobody has opened it yet.' : 'Everyone has seen it. 🎉'}
        </Text>
      ) : (
        list.slice(0, shown).map((r, i) => (
          <View key={r.id}>
            {i ? <Divider /> : null}
            <View style={styles.reader}>
              <Avatar text={initialsOf(r.name) || '?'} size={32} />
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong" numberOfLines={1}>
                  {r.name}
                </Text>
                <Text variant="small" numberOfLines={1}>
                  {[r.rollNo, r.role === 'student' ? null : ROLE[r.role]].filter(Boolean).join(' · ') || ROLE[r.role]}
                </Text>
              </View>
              {r.readAt ? (
                <View style={{ alignItems: 'flex-end' }}>
                  <Check color={colors.green} size={14} />
                  <Text variant="small">{`${dateLong(r.readAt).replace(/,? \d{4}$/, '')} · ${clock(r.readAt)}`}</Text>
                </View>
              ) : null}
            </View>
          </View>
        ))
      )}
      {list.length > shown ? <Button title={`Show ${Math.min(PAGE, list.length - shown)} more`} kind="secondary" compact onPress={() => setShown((x) => x + PAGE)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  reader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  title: { fontFamily: fonts.display, fontSize: 26, lineHeight: 32, letterSpacing: -0.6, color: colors.text, marginTop: 12 },
  byline: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  to: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  bodyCard: { marginTop: 16, paddingVertical: 18 },
});
