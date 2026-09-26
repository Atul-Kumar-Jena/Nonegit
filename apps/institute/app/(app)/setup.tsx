import { Pressable, StyleSheet, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { CheckCircle2, ChevronRight, Circle } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Card, Loading, ProgressBar, SectionLabel, Text } from '@kit/components/ui';
import { colors } from '@kit/theme';
import { Header } from '@/components/forms';
import { useSetupProgress } from '@/setup';

/** The onboarding checklist, in the order that makes everything else work. */
export default function Setup() {
  const p = useSetupProgress();
  return (
    <Screen>
      <Header title="Set up your institution" />
      {!p.loaded ? (
        <Loading />
      ) : (
        <>
          <Text variant="small">Do these once, in this order. Each step unlocks the next; you can come back any time.</Text>
          <View style={{ marginTop: 14 }}>
            <ProgressBar value={(p.done / p.total) * 100} />
            <Text variant="monoSmall" style={{ marginTop: 6 }}>
              {p.done} of {p.total} done
            </Text>
          </View>
          <View style={{ gap: 10, marginTop: 16 }}>
            {p.steps.map((s, i) => (
              <Pressable key={s.key} onPress={() => router.push(s.href as Href)} accessibilityRole="button" accessibilityLabel={`${s.title}${s.done ? ', done' : ''}`}>
                <Card style={styles.row} tone={s.done ? undefined : i === p.steps.findIndex((x) => !x.done) ? 'cyan' : undefined}>
                  {s.done ? <CheckCircle2 color={colors.green} size={22} /> : <Circle color={colors.textDim} size={22} />}
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong">
                      {i + 1}. {s.title}
                      {s.optional ? <Text variant="small"> (optional)</Text> : null}
                    </Text>
                    <Text variant="small">{s.why}</Text>
                  </View>
                  <ChevronRight color={colors.textDim} size={18} />
                </Card>
              </Pressable>
            ))}
          </View>
          <SectionLabel>How data stays unique and correct</SectionLabel>
          <Card style={{ gap: 8 }}>
            {[
              'An email or phone number belongs to exactly one person in Attendly.',
              'Roll numbers, course codes and room names are unique inside your institution.',
              'Each person works from one phone; switching needs an admin’s approval.',
              'A student has at most one attendance mark per class — scanning twice changes nothing.',
              'Each weekly slot creates exactly one class per date, even if saved twice.',
              'Everything done offline carries a one-time ID, so uploading it twice never double-counts.',
              'Every change to attendance is signed, timestamped and kept in a tamper-evident audit log.',
            ].map((t) => (
              <Text key={t} variant="small" color={colors.text}>
                • {t}
              </Text>
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 12 } });
