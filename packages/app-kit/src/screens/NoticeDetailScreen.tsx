import { useEffect } from 'react';
import { Alert, Platform, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, Pencil, Pin, Trash2, Users } from 'lucide-react-native';
import { CategoryPill, ReactionBar, useNotice } from '../components/Notices';
import { RichText } from '../components/RichText';
import { Screen } from '../components/Screen';
import { Avatar, Button, Card, ErrorState, IconButton, Loading, ProgressBar, Text } from '../components/ui';
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

const styles = StyleSheet.create({
  title: { fontFamily: fonts.bold, fontSize: 26, lineHeight: 32, letterSpacing: -0.6, color: colors.text, marginTop: 12 },
  byline: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  to: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  bodyCard: { marginTop: 16, paddingVertical: 18 },
});
