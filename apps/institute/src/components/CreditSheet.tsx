import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Award } from 'lucide-react-native';
import { CREDIT_REASONS, type CreditBody, type CreditReason, type CreditResult } from '@attendly/protocol';
import { Button, Card, Input, Loading, Notice, Segmented, Text } from '@kit/components/ui';
import { dayLabel } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { staffApi } from '@/api';
import { Checkbox, Chips, DateField, Field, Select, Sheet, ToggleRow, addDays } from '@/components/forms';

type Amount = 'classes' | 'percent' | 'sessions';

/**
 * Attendance credit for one student: missed classes counted as attended for a reason (medical
 * leave, a fest, sports…) with a note — as a number of classes, a percentage, or picked classes,
 * optionally only within dates. Shows the effect first, then saves; the student is told.
 */
export function CreditSheet({
  studentId,
  studentName,
  subjects,
  canAll,
  today,
  onClose,
}: {
  studentId: string;
  studentName: string;
  subjects: { courseId: string; code: string; title: string }[];
  /** May credit every subject at once (admins / "Subjects & batches"). */
  canAll: boolean;
  today: string;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [reason, setReason] = useState<CreditReason>('medical');
  const [note, setNote] = useState('');
  const [courseId, setCourseId] = useState<string | null>(canAll ? null : (subjects[0]?.courseId ?? null));
  const [kind, setKind] = useState<Amount>('classes');
  const [value, setValue] = useState('2');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [ranged, setRanged] = useState(false);
  const [from, setFrom] = useState(addDays(today, -7));
  const [to, setTo] = useState(today);
  const [preview, setPreview] = useState<CreditResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<CreditResult | null>(null);

  const missed = useQuery({
    queryKey: ['staff', 'missed', studentId, courseId],
    queryFn: () => staffApi.missed(api, studentId, courseId ?? undefined),
    enabled: kind === 'sessions',
  });

  const n = Number(value);
  const amount: CreditBody['amount'] | null =
    kind === 'sessions'
      ? picked.size
        ? { kind: 'sessions', sessionIds: [...picked] }
        : null
      : Number.isFinite(n) && n > 0
        ? kind === 'classes'
          ? { kind: 'classes', classes: Math.round(n) }
          : { kind: 'percent', percent: n }
        : null;
  const body = (p: boolean): CreditBody | null =>
    amount && note.trim().length >= 3
      ? { courseId, reason, note: note.trim(), amount, preview: p, ...(ranged && kind !== 'sessions' ? { from, to } : {}) }
      : null;

  // Live preview of the effect.
  const key = JSON.stringify(body(true));
  useEffect(() => {
    const b = body(true);
    setPreview(null);
    if (!b) return;
    let alive = true;
    const t = setTimeout(() => {
      staffApi
        .giveCredit(api, studentId, b)
        .then((r) => alive && setPreview(r))
        .catch((err: Error) => alive && setError(err.message));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    const b = body(false);
    if (!b) return;
    setBusy(true);
    setError(null);
    try {
      const r = await staffApi.giveCredit(api, studentId, b);
      setDone(r);
      void qc.invalidateQueries({ queryKey: ['staff'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the credit.');
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <Sheet open onClose={onClose} title="Credit given">
        <Notice tone="green" message={`${done.credited} ${done.credited === 1 ? 'class' : 'classes'} counted as attended for ${studentName}. They were notified.`} />
        {done.perSubject
          .filter((p) => p.credited)
          .map((p) => (
            <Text key={p.courseId} variant="small" color={colors.text} style={{ marginTop: 8 }}>
              {`${p.code}: +${p.credited} · ${p.before ?? '—'}% → ${p.after ?? '—'}%`}
            </Text>
          ))}
        <Button title="Done" onPress={onClose} style={{ marginTop: 16 }} />
      </Sheet>
    );

  return (
    <Sheet open onClose={onClose} title={`Attendance credit · ${studentName}`} scroll>
      <Text variant="small">Count missed classes as attended — for medical leave, a fest, sports or college duty. The student sees the reason and your note.</Text>
      <Field label="Reason">
        <Chips value={reason} options={(Object.keys(CREDIT_REASONS) as CreditReason[]).map((r) => ({ value: r, label: CREDIT_REASONS[r] }))} onChange={setReason} />
      </Field>
      <Field label="Note (required)">
        <Input value={note} onChangeText={setNote} placeholder="e.g. Hospitalised 3–5 Oct, certificate seen" maxLength={300} multiline />
      </Field>
      <Field label="Subject">
        <Select
          title="Subject"
          value={courseId}
          onChange={(v) => {
            setCourseId(v);
            setPicked(new Set());
          }}
          {...(canAll ? { allowNone: 'Every subject' } : {})}
          placeholder="Choose a subject"
          options={subjects.map((s) => ({ value: s.courseId, label: `${s.code} · ${s.title}` }))}
        />
      </Field>
      <Field label="How much">
        <Segmented
          value={kind}
          options={[
            { value: 'classes', label: 'Classes' },
            { value: 'percent', label: '%' },
            { value: 'sessions', label: 'Pick classes' },
          ]}
          onChange={setKind}
        />
      </Field>
      {kind !== 'sessions' ? (
        <>
          <View style={styles.amountRow}>
            <TextInput
              value={value}
              onChangeText={(v) => setValue(v.replace(/[^0-9.]/g, '').slice(0, 5))}
              keyboardType="decimal-pad"
              accessibilityLabel={kind === 'classes' ? 'Number of classes' : 'Percentage'}
              selectTextOnFocus
              style={styles.amountBox}
            />
            <Text variant="bodyStrong" style={{ flex: 1 }}>{kind === 'classes' ? `missed ${n === 1 ? 'class' : 'classes'}${courseId ? '' : ' per subject'}` : `% of the classes held${courseId ? '' : ', per subject'}`}</Text>
          </View>
          <ToggleRow label="Only classes between dates" hint="E.g. the days of a medical leave." value={ranged} onChange={setRanged} />
          {ranged ? (
            <>
              <Field label="From">
                <DateField value={from} onChange={setFrom} />
              </Field>
              <Field label="To">
                <DateField value={to} onChange={setTo} />
              </Field>
            </>
          ) : null}
        </>
      ) : (
        <View style={{ gap: 6, marginTop: 10 }}>
          {missed.isPending ? (
            <Loading />
          ) : (missed.data ?? []).length === 0 ? (
            <Text variant="small">No missed classes {courseId ? 'in this subject' : ''} this term.</Text>
          ) : (
            (missed.data ?? []).slice(0, 120).map((m) => {
              const on = picked.has(m.sessionId);
              return (
                <Pressable
                  key={m.sessionId}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  onPress={() =>
                    setPicked((cur) => {
                      const next = new Set(cur);
                      if (next.has(m.sessionId)) next.delete(m.sessionId);
                      else next.add(m.sessionId);
                      return next;
                    })
                  }
                  style={[styles.missed, on && { borderColor: colors.text }]}
                >
                  <Checkbox checked={on} size={22} />
                  <Text variant="bodyStrong" style={{ width: 70 }}>
                    {m.code}
                  </Text>
                  <Text variant="small" style={{ flex: 1 }}>
                    {`${dayLabel(m.scheduledStart)}${m.lectureNo ? ` · Lecture ${m.lectureNo}` : ''}`}
                  </Text>
                </Pressable>
              );
            })
          )}
        </View>
      )}

      {preview ? (
        <Card style={{ marginTop: 16, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Award color={colors.green} size={18} />
            <Text variant="bodyStrong">{preview.credited ? `${preview.credited} ${preview.credited === 1 ? 'class' : 'classes'} will count as attended` : 'No missed classes match'}</Text>
          </View>
          {preview.perSubject.map((p) => (
            <Text key={p.courseId} style={styles.effect}>
              {`${p.code}   +${p.credited}   ${p.before ?? '—'}% → ${p.after ?? '—'}%`}
            </Text>
          ))}
        </Card>
      ) : null}
      {error ? <Notice tone="red" message={error} onDismiss={() => setError(null)} /> : null}
      <Button title="Give credit & notify" onPress={() => void save()} loading={busy} disabled={!body(false) || !preview?.credited} style={{ marginTop: 16 }} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  amountBox: { width: 84, fontFamily: fonts.monoMedium, fontSize: 22, color: colors.text, textAlign: 'center', paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.borderHi, backgroundColor: colors.bgRaised },
  missed: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  effect: { fontFamily: fonts.monoMedium, fontSize: 14, color: colors.text },
});
