import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Send, X } from 'lucide-react-native';
import { ChangeRequest, STUDENT_TOPIC_LABELS, type StudentRequestTopic } from '@attendly/protocol';
import { Button, Input, Notice, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { qk } from '@/state/queries';

const TOPICS: StudentRequestTopic[] = ['reschedule', 'extra', 'cancel', 'doubt', 'other'];

/** Ask the teacher of one class something. They get a notification and reply in their app. */
export function AskTeacherSheet({
  session,
  onClose,
}: {
  session: { sessionId: string; courseCode: string; courseTitle: string; when: string; teacher?: string | null };
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [topic, setTopic] = useState<StudentRequestTopic>('reschedule');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await api.authed('POST', '/v1/me/requests', ChangeRequest, { sessionId: session.sessionId, topic, note: note.trim() });
      setSent(true);
      void qc.invalidateQueries({ queryKey: qk.requests });
      setTimeout(onClose, 1400);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t send it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Text variant="heading" style={{ flex: 1 }}>
              Ask your teacher
            </Text>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10}>
              <X color={colors.textMuted} size={20} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text variant="bodyStrong">
              {session.courseCode} · {session.courseTitle}
            </Text>
            <Text variant="small">
              {session.when}
              {session.teacher ? ` · ${session.teacher}` : ''}
            </Text>
            <Text variant="label" style={{ marginTop: 16, marginBottom: 8 }}>
              What is it about?
            </Text>
            <View style={styles.chips}>
              {TOPICS.map((t) => (
                <Pressable key={t} onPress={() => setTopic(t)} accessibilityRole="radio" accessibilityState={{ selected: topic === t }} style={[styles.chip, topic === t && styles.chipOn]}>
                  <Text variant="small" color={topic === t ? colors.text : colors.textMuted}>
                    {STUDENT_TOPIC_LABELS[t]}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text variant="label" style={{ marginTop: 16, marginBottom: 8 }}>
              Your message
            </Text>
            <Input value={note} onChangeText={setNote} placeholder="e.g. Half the class has a lab exam at that time" maxLength={500} multiline />
            <Text variant="small" style={{ marginTop: 8 }}>
              Your teacher gets a notification with your name and roll number, and replies here. Be polite — it’s kept on record.
            </Text>
            {error ? (
              <View style={{ marginTop: 12 }}>
                <Notice tone="red" message={error} />
              </View>
            ) : null}
            {sent ? (
              <View style={{ marginTop: 12 }}>
                <Notice tone="green" message="Sent. You’ll get a notification when your teacher replies." />
              </View>
            ) : (
              <Button title="Send" onPress={() => void send()} loading={busy} disabled={note.trim().length < 3} icon={<Send color="#03141c" size={16} />} style={{ marginTop: 16 }} />
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, padding: 20, paddingBottom: 36, maxHeight: '88%' },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderHi, marginBottom: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised },
  chipOn: { borderColor: colors.cyan, backgroundColor: colors.cyanSoft },
});
