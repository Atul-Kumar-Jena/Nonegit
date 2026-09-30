import { Tabs, router } from 'expo-router';
import { CalendarDays, House, LayoutGrid, Library, Play } from 'lucide-react-native';
import { AppTabBar } from '@kit/components/TabBar';
import { colors } from '@kit/theme';

const TABS = {
  home: { label: 'Today', icon: House },
  timetable: { label: 'Timetable', icon: CalendarDays },
  classes: { label: 'Classes', icon: Library },
  more: { label: 'More', icon: LayoutGrid },
};

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(p) => (
        <AppTabBar {...p} tabs={TABS} action={{ label: 'Take attendance now', icon: <Play color={colors.ink} size={22} strokeWidth={2.4} fill={colors.ink} />, onPress: () => router.push('/attend') }} />
      )}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="timetable" />
      <Tabs.Screen name="classes" />
      <Tabs.Screen name="more" />
    </Tabs>
  );
}
