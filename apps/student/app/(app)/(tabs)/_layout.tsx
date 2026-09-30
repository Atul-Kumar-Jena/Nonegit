import { Tabs, router } from 'expo-router';
import { BookOpen, CalendarDays, House, ScanLine, UserRound } from 'lucide-react-native';
import { AppTabBar } from '@kit/components/TabBar';
import { colors } from '@kit/theme';

const TABS = {
  home: { label: 'Home', icon: House },
  timetable: { label: 'Timetable', icon: CalendarDays },
  subjects: { label: 'Subjects', icon: BookOpen },
  profile: { label: 'Profile', icon: UserRound },
};

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(p) => <AppTabBar {...p} tabs={TABS} action={{ label: 'Scan attendance QR', icon: <ScanLine color={colors.ink} size={24} strokeWidth={2.3} />, onPress: () => router.push('/scan') }} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="timetable" />
      <Tabs.Screen name="subjects" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
