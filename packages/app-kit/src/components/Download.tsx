import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { FileSpreadsheet, FileText } from 'lucide-react-native';
import { downloadDoc, type ExportDoc } from '../lib/export';
import { timeAgo } from '../lib/format';
import { colors, fonts, radius } from '../theme';
import { Button, Card, Notice, Text } from './ui';

type Format = 'pdf' | 'xlsx';

/**
 * Fetches the freshest report and turns it into a file. With no connection it falls back to the
 * last copy saved on the phone (and says how old it is), so a download works at any point.
 */
function useDownload<T>(queryKey: QueryKey, fetch: () => Promise<T>, toDoc: (data: T) => ExportDoc, fallback?: () => T | undefined) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<Format | null>(null);
  const [note, setNote] = useState<{ tone: 'red' | 'amber'; text: string } | null>(null);
  async function run(f: Format) {
    if (busy) return;
    setBusy(f);
    setNote(null);
    try {
      let data: T | undefined;
      try {
        data = await qc.fetchQuery({ queryKey, queryFn: fetch, staleTime: 0, retry: 0 });
      } catch (err) {
        data = qc.getQueryData<T>(queryKey) ?? fallback?.();
        if (data === undefined) throw err;
        const at = qc.getQueryState(queryKey)?.dataUpdatedAt;
        setNote({ tone: 'amber', text: `No connection — this file uses the copy saved on this phone${at ? ` (${timeAgo(new Date(at).toISOString())})` : ''}.` });
      }
      await downloadDoc(toDoc(data as T), f);
    } catch (err) {
      setNote({ tone: 'red', text: err instanceof Error && err.message ? `Couldn’t make the file: ${err.message}` : 'Couldn’t make the file. Try again.' });
    } finally {
      setBusy(null);
    }
  }
  return { busy, note, run, clear: () => setNote(null) };
}

/** A card: title, one line of help, and "PDF" / "Excel" buttons. */
export function DownloadCard<T>({ title = 'Download', hint, queryKey, fetch, toDoc, fallback }: { title?: string; hint?: string; queryKey: QueryKey; fetch: () => Promise<T>; toDoc: (data: T) => ExportDoc; fallback?: () => T | undefined }) {
  const d = useDownload(queryKey, fetch, toDoc, fallback);
  return (
    <Card style={{ gap: 12 }}>
      <View>
        <Text variant="bodyStrong">{title}</Text>
        {hint ? <Text variant="small" style={{ marginTop: 2 }}>{hint}</Text> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button title="PDF" kind="secondary" compact loading={d.busy === 'pdf'} disabled={!!d.busy} onPress={() => void d.run('pdf')} icon={<FileText color={colors.text} size={16} />} style={{ flex: 1 }} />
        <Button title="Excel" kind="secondary" compact loading={d.busy === 'xlsx'} disabled={!!d.busy} onPress={() => void d.run('xlsx')} icon={<FileSpreadsheet color={colors.text} size={16} />} style={{ flex: 1 }} />
      </View>
      {d.note ? <Notice tone={d.note.tone} message={d.note.text} onDismiss={d.clear} /> : null}
    </Card>
  );
}

/** A compact list row: a label on the left, PDF and Excel icons on the right. */
export function DownloadRow<T>({ label, detail, queryKey, fetch, toDoc, fallback }: { label: string; detail?: string; queryKey: QueryKey; fetch: () => Promise<T>; toDoc: (data: T) => ExportDoc; fallback?: () => T | undefined }) {
  const d = useDownload(queryKey, fetch, toDoc, fallback);
  const icon = (f: Format) => (
    <Pressable
      onPress={() => void d.run(f)}
      disabled={!!d.busy}
      accessibilityRole="button"
      accessibilityLabel={`Download ${label} as ${f === 'pdf' ? 'PDF' : 'Excel'}`}
      hitSlop={6}
      style={({ pressed }) => [styles.pill, pressed && { opacity: 0.6 }]}
    >
      {d.busy === f ? <ActivityIndicator size="small" color={colors.text} /> : f === 'pdf' ? <FileText color={colors.text} size={15} /> : <FileSpreadsheet color={colors.text} size={15} />}
      <Text style={styles.pillText}>{f === 'pdf' ? 'PDF' : 'Excel'}</Text>
    </Pressable>
  );
  return (
    <View style={styles.rowWrap}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {label}
          </Text>
          {detail ? (
            <Text variant="small" numberOfLines={1}>
              {detail}
            </Text>
          ) : null}
        </View>
        {icon('pdf')}
        {icon('xlsx')}
      </View>
      {d.note ? <Notice tone={d.note.tone} message={d.note.text} onDismiss={d.clear} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  rowWrap: { gap: 8, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderHi, minHeight: 36 },
  pillText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.text },
});
