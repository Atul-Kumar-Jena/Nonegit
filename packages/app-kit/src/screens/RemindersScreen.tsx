import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, BellRing, Check, Timer } from 'lucide-react-native';
import { Screen } from '../components/Screen';
import { Button, Card, IconButton, Notice, Text } from '../components/ui';
import { enablePhoneNotifications, phoneNotificationStatus } from '../lib/notifications';
import { REMINDER_CHOICES, countdownAlertsAvailable, previewCountdownAlert, reminderLabel, saveReminderSettings, useReminderSettings } from '../lib/reminders';
import { useSession } from '../state/session';
import { colors, fonts, radius } from '../theme';

/** Choose when to be reminded before each class. */
export default function RemindersScreen() {
  const { audience } = useSession();
  const s = useReminderSettings();
  const [phone, setPhone] = useState<'granted' | 'denied' | 'unavailable' | null>(null);
  useEffect(() => {
    void phoneNotificationStatus().then(setPhone);
  }, []);
  const staff = !audience.allowedRoles.includes('student');
  const pinLead = s.minutes.filter((m) => m <= 60)[0];
  const toggle = (m: number) => void saveReminderSettings({ ...s, minutes: s.minutes.includes(m) ? s.minutes.filter((x) => x !== m) : [...s.minutes, m] });

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconButton label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}>
          <ArrowLeft color={colors.text} size={18} />
        </IconButton>
        <Text variant="heading" style={{ flex: 1 }}>
          Class reminders
        </Text>
      </View>
      <Text variant="title" style={{ marginTop: 24 }}>
        Never miss a class
      </Text>
      <Text variant="body" style={{ marginTop: 6 }}>
        {staff
          ? 'A notification (with sound) before each class you teach — including ones you’re covering — with the time and room.'
          : 'A notification (with sound) before each of your classes, with the time and room.'}{' '}
        They are set on this phone, so they arrive on time even without internet, and follow every timetable change.
      </Text>
      <Text variant="small" style={{ marginTop: 8 }}>
        Attendly also sends everyone a “starts in 5 min” reminder for each class — it follows last-minute changes even if you haven’t opened the app.
      </Text>

      {phone === 'denied' ? (
        <Card tone="amber" style={{ marginTop: 16, gap: 10 }}>
          <Text variant="small">Notifications are off for this app, so reminders can’t ring.</Text>
          <Button title="Turn on notifications" compact onPress={() => void enablePhoneNotifications().then(setPhone)} />
        </Card>
      ) : null}

      <Card style={[styles.row, { marginTop: 18 }]}>
        <BellRing color={s.enabled ? colors.text : colors.textDim} size={20} />
        <Text variant="bodyStrong" style={{ flex: 1 }}>
          Reminders
        </Text>
        <Switch
          value={s.enabled}
          onValueChange={(v) => void saveReminderSettings({ ...s, enabled: v })}
          trackColor={{ true: colors.text, false: colors.borderHi }}
          thumbColor={s.enabled ? colors.bg : colors.textMuted}
          accessibilityLabel="Class reminders"
        />
      </Card>

      {s.enabled ? (
        <>
          <Text variant="label" style={{ marginTop: 24, marginBottom: 10 }}>
            Remind me (pick any)
          </Text>
          <View style={styles.grid}>
            {REMINDER_CHOICES.map((m) => {
              const on = s.minutes.includes(m);
              return (
                <Pressable key={m} onPress={() => toggle(m)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={[styles.choice, on && styles.choiceOn]}>
                  {on ? <Check color={colors.bg} size={14} /> : null}
                  <Text style={[styles.choiceText, on && { color: colors.bg }]}>{reminderLabel(m)}</Text>
                </Pressable>
              );
            })}
          </View>
          {s.minutes.length === 0 ? (
            <View style={{ marginTop: 12 }}>
              <Notice tone="amber" message="Pick at least one time, or turn reminders off." />
            </View>
          ) : (
            <Text variant="small" style={{ marginTop: 14 }}>
              You’ll be reminded {s.minutes.map(reminderLabel).join(', ')} each class.
            </Text>
          )}
          {countdownAlertsAvailable ? (
            <Card style={{ marginTop: 18, gap: 12 }}>
              <View style={styles.row}>
                <Timer color={s.pinned ? colors.text : colors.textDim} size={20} />
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">Pinned countdown</Text>
                  <Text variant="small">
                    {s.pinned
                      ? pinLead !== undefined
                        ? `${reminderLabel(pinLead)}, a notification stays on top with a live timer to the class until you tap “Got it”.`
                        : 'Pick a reminder of an hour or less to get the pinned countdown.'
                      : 'Off: reminders are ordinary notifications you can swipe away.'}
                  </Text>
                </View>
                <Switch
                  value={s.pinned}
                  onValueChange={(v) => void saveReminderSettings({ ...s, pinned: v })}
                  trackColor={{ true: colors.text, false: colors.borderHi }}
                  thumbColor={s.pinned ? colors.bg : colors.textMuted}
                  accessibilityLabel="Pinned countdown before class"
                />
              </View>
              {s.pinned ? <Button title="Show me an example" kind="secondary" compact onPress={() => void previewCountdownAlert()} icon={<Timer color={colors.text} size={15} />} /> : null}
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderHi },
  choiceOn: { backgroundColor: colors.text, borderColor: colors.text },
  choiceText: { fontFamily: fonts.medium, fontSize: 14, color: colors.text },
});
