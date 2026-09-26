import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CheckCircle2, CloudOff, RefreshCw, Trash2, XCircle } from 'lucide-react-native';
import { outbox, useOutbox } from '../lib/outbox';
import { timeAgo } from '../lib/format';
import { useSession } from '../state/session';
import { colors, toneColor } from '../theme';
import { flushOutboxNow } from './OutboxRunner';
import { Button, Card, Text } from './ui';

/**
 * Shows what is waiting to upload, what failed (with retry/discard) and the
 * latest upload results. Renders nothing when there is nothing to say.
 */
export function SyncBanner({ showResults = true }: { showResults?: boolean }) {
  const { api } = useSession();
  const { pending, failed, results, syncing } = useOutbox();
  const [open, setOpen] = useState(false);
  const recent = showResults ? results.filter((r) => Date.now() - r.at < 30 * 60_000).slice(0, 3) : [];
  if (!pending.length && !failed.length && !recent.length) return null;

  return (
    <View style={{ gap: 8, marginTop: 14 }}>
      {pending.length ? (
        <Card tone="cyan" style={styles.row}>
          <CloudOff color={colors.cyan} size={18} />
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">
              {pending.length} saved offline · {syncing ? 'uploading…' : 'will upload automatically'}
            </Text>
            <Text variant="small" numberOfLines={2}>
              {pending.map((p) => p.label).join(' · ')}
            </Text>
          </View>
          <Button title="Send now" kind="secondary" compact loading={syncing} onPress={() => void flushOutboxNow(api)} />
        </Card>
      ) : null}
      {failed.length ? (
        <Card tone="red" style={{ gap: 10 }}>
          <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" style={styles.row}>
            <XCircle color={colors.red} size={18} />
            <Text variant="bodyStrong" style={{ flex: 1 }}>
              {failed.length} couldn’t be uploaded
            </Text>
            <Text variant="small" color={colors.cyan}>
              {open ? 'Hide' : 'Details'}
            </Text>
          </Pressable>
          {open
            ? failed.map((f) => (
                <View key={f.id} style={styles.failed}>
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong">{f.label}</Text>
                    <Text variant="small">{f.lastError ?? 'Unknown error'}</Text>
                  </View>
                  <Pressable onPress={() => void outbox.retry(f.id).then(() => flushOutboxNow(api))} accessibilityRole="button" accessibilityLabel="Retry" hitSlop={8}>
                    <RefreshCw color={colors.text} size={18} />
                  </Pressable>
                  <Pressable onPress={() => void outbox.discard(f.id)} accessibilityRole="button" accessibilityLabel="Discard" hitSlop={8}>
                    <Trash2 color={colors.textDim} size={18} />
                  </Pressable>
                </View>
              ))
            : null}
        </Card>
      ) : null}
      {recent.map((r) => (
        <View key={r.id} style={[styles.result, { borderColor: r.ok ? toneColor.green.line : toneColor.amber.line }]}>
          {r.ok ? <CheckCircle2 color={colors.green} size={16} /> : <XCircle color={colors.amber} size={16} />}
          <Text variant="small" style={{ flex: 1 }} color={colors.text}>
            {r.label}: {r.message}
          </Text>
          <Text variant="monoSmall">{timeAgo(new Date(r.at).toISOString())}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  failed: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  result: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
});
