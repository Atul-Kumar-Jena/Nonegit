import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCheck, PenSquare } from 'lucide-react-native';
import { NOTICE_CATEGORIES, type NoticeCategory } from '@attendly/protocol';
import { Screen } from '../components/Screen';
import { ChipRow, NoticeCard, useNotices, type NoticeFilter } from '../components/Notices';
import { Button, Card, ErrorState, IconButton, Loading, SectionLabel, Text } from '../components/ui';
import { useApi } from '../state/session';
import { colors } from '../theme';

/**
 * Notice centre: everything sent to you (and, for staff, by you), newest first, pinned on top.
 * `canCompose` shows "New notice" (Institute app).
 */
export default function NoticesScreen({ canCompose = false }: { canCompose?: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<NoticeFilter>('all');
  const [category, setCategory] = useState<NoticeCategory | 'any'>('any');
  const q = useNotices(filter, category === 'any' ? undefined : category);
  const pages = q.data?.pages ?? [];
  const pinned = pages[0]?.pinned ?? [];
  const items = pages.flatMap((p) => p.items);
  const unread = pages[0]?.unread ?? 0;

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconButton label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}>
          <ArrowLeft color={colors.text} size={18} />
        </IconButton>
        <View style={{ flex: 1 }}>
          <Text variant="label">{unread ? `${unread} unread` : 'All caught up'}</Text>
          <Text variant="heading">Notice centre</Text>
        </View>
        {unread ? (
          <IconButton
            label="Mark all read"
            onPress={() =>
              void api
                .readAllNotices()
                .then(() => qc.invalidateQueries({ queryKey: ['notices'] }))
                .catch(() => undefined)
            }
          >
            <CheckCheck color={colors.text} size={18} />
          </IconButton>
        ) : null}
      </View>

      {canCompose ? <Button title="New notice" onPress={() => router.push('/notice-compose' as never)} icon={<PenSquare color={colors.bg} size={16} />} style={{ marginTop: 16 }} /> : null}

      <View style={{ marginTop: 16, gap: 10 }}>
        <ChipRow
          value={filter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'unread', label: 'Unread' },
            { value: 'pinned', label: 'Pinned' },
            ...(canCompose ? [{ value: 'mine' as const, label: 'Sent by me' }] : []),
          ]}
          onChange={setFilter}
        />
        <ChipRow value={category} options={[{ value: 'any' as const, label: 'Every topic' }, ...NOTICE_CATEGORIES.map((c) => ({ value: c.key, label: `${c.emoji} ${c.label}` }))]} onChange={setCategory} />
      </View>

      {q.isPending ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <View style={{ marginTop: 20 }}>
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        </View>
      ) : (
        <>
          {pinned.length ? (
            <>
              <SectionLabel>Pinned</SectionLabel>
              <View style={{ gap: 10 }}>
                {pinned.map((n) => (
                  <NoticeCard key={n.id} n={n} />
                ))}
              </View>
            </>
          ) : null}
          {pinned.length && items.length ? <SectionLabel>Latest</SectionLabel> : null}
          <View style={{ gap: 10, marginTop: pinned.length ? 0 : 16 }}>
            {items.length === 0 && !pinned.length ? (
              <Card>
                <Text variant="bodyStrong">{filter === 'unread' ? 'Nothing unread.' : 'No notices yet.'}</Text>
                <Text variant="small" style={{ marginTop: 4 }}>
                  {canCompose ? 'Tap “New notice” to send one to a batch, your subjects, or (with permission) everyone.' : 'Announcements from your institution and professors appear here, with a notification.'}
                </Text>
              </Card>
            ) : (
              items.map((n) => <NoticeCard key={n.id} n={n} />)
            )}
          </View>
          {q.hasNextPage ? <Button title="Load older notices" kind="secondary" compact onPress={() => void q.fetchNextPage()} loading={q.isFetchingNextPage} style={{ marginTop: 14 }} /> : null}
        </>
      )}
    </Screen>
  );
}
