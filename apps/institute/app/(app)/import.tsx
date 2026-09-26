import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import type { BulkImportResponse } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, Notice, SectionLabel, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors, fonts, radius } from '@kit/theme';
import { staffApi } from '@/api';
import { Checkbox, Chips, Field, Header, Select } from '@/components/forms';
import { parseRows } from '@/import-parse';
import { useBatches, useCourses } from '@/queries';

const EXAMPLE = 'Aarav Sharma, 21CS1001, aarav@college.edu\nDiya Patel, 21CS1002, diya@college.edu, +919876543210';

/** Paste a class list from Excel / Google Sheets / a PDF and add everyone at once. */
export default function Import() {
  const params = useLocalSearchParams<{ role?: string; batchId?: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const courses = useCourses();
  const [role, setRole] = useState<'student' | 'teacher'>(params.role === 'teacher' ? 'teacher' : 'student');
  const [text, setText] = useState('');
  const [courseIds, setCourseIds] = useState<Set<string>>(new Set());
  const batches = useBatches();
  const [batchId, setBatchId] = useState<string | null>(params.batchId ? String(params.batchId) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkImportResponse | null>(null);

  const parsed = useMemo(() => parseRows(text, role), [text, role]);

  async function submit() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const all: BulkImportResponse = { created: 0, skipped: [] };
      // The server takes up to 500 rows per request.
      for (let i = 0; i < parsed.rows.length; i += 500) {
        const chunk = parsed.rows.slice(i, i + 500);
        const r = await staffApi.importPeople(api, chunk, role === 'student' ? [...courseIds] : [], role === 'student' ? batchId : null);
        all.created += r.created;
        all.skipped.push(...r.skipped.map((s) => ({ ...s, row: s.row + i })));
      }
      setResult(all);
      if (all.created) setText('');
      void qc.invalidateQueries({ queryKey: ['staff'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard>
      <Header title="Add many people" />
      <Chips value={role} options={[{ value: 'student', label: 'Students' }, { value: 'teacher', label: 'Teachers' }]} onChange={setRole} />
      <Text variant="small" style={{ marginTop: 12 }}>
        Copy rows from a spreadsheet and paste them here — one person per line. A header row (Name, Roll, Email, Phone, Department, Semester) is used if present; otherwise columns are recognised by their shape. Phone numbers need the country code, e.g. +91….
      </Text>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder={EXAMPLE}
        placeholderTextColor={colors.textDim}
        style={styles.area}
        autoCapitalize="none"
        autoCorrect={false}
        textAlignVertical="top"
        accessibilityLabel="Pasted list"
      />
      {text.trim() ? (
        <Card style={{ marginTop: 12, gap: 6 }}>
          <Text variant="bodyStrong">
            {parsed.rows.length} ready · {parsed.problems.length} need fixing
          </Text>
          {parsed.rows.slice(0, 5).map((r, i) => (
            <Text key={i} variant="monoSmall" numberOfLines={1}>
              {[r.fullName, r.rollNo, r.email ?? r.phone].filter(Boolean).join(' · ')}
            </Text>
          ))}
          {parsed.rows.length > 5 ? <Text variant="monoSmall">…and {parsed.rows.length - 5} more</Text> : null}
          {parsed.problems.slice(0, 5).map((p) => (
            <Text key={p} variant="small" color={colors.amber}>
              {p}
            </Text>
          ))}
        </Card>
      ) : null}

      {role === 'student' ? (
        <Field label="Batch (optional)" hint="They’re enrolled in every course the batch takes.">
          <Select
            title="Batch"
            value={batchId}
            onChange={setBatchId}
            allowNone="No batch"
            options={(batches.data ?? []).filter((b) => b.active).map((b) => ({ value: b.id, label: b.name, sub: `${b.size} students · ${b.courseIds.length} courses` }))}
          />
        </Field>
      ) : null}
      {role === 'student' && (courses.data ?? []).some((c) => c.active) ? (
        <>
          <SectionLabel>Also enrol them in</SectionLabel>
          <Card style={{ gap: 2 }}>
            {(courses.data ?? [])
              .filter((c) => c.active)
              .map((c) => {
                const on = courseIds.has(c.id);
                return (
                  <Pressable
                    key={c.id}
                    onPress={() =>
                      setCourseIds((cur) => {
                        const n = new Set(cur);
                        if (n.has(c.id)) n.delete(c.id);
                        else n.add(c.id);
                        return n;
                      })
                    }
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    style={styles.course}
                  >
                    <Checkbox checked={on} size={20} />
                    <Text variant="body" color={on ? colors.text : undefined} style={{ flex: 1 }}>
                      {c.code} · {c.title}
                    </Text>
                  </Pressable>
                );
              })}
          </Card>
        </>
      ) : null}

      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}
      {result ? (
        <Card tone={result.skipped.length ? 'amber' : 'green'} style={{ marginTop: 12, gap: 6 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Badge label={`${result.created} added`} tone="green" dot={false} />
            {result.skipped.length ? <Badge label={`${result.skipped.length} skipped`} tone="amber" dot={false} /> : null}
          </View>
          {result.skipped.slice(0, 10).map((s) => (
            <Text key={s.row} variant="small" color={colors.text}>
              Row {s.row}: {s.reason}
            </Text>
          ))}
          {result.created ? <Text variant="small">They can sign in now with their email or phone.</Text> : null}
        </Card>
      ) : null}
      <Button title={`Add ${parsed.rows.length || ''} ${role === 'student' ? 'students' : 'teachers'}`.replace('  ', ' ')} onPress={() => void submit()} loading={busy} disabled={!parsed.rows.length} style={{ marginTop: 18 }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  area: { marginTop: 12, minHeight: 170, maxHeight: 320, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised, padding: 14, color: colors.text, fontFamily: fonts.mono, fontSize: 13 },
  course: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
});
