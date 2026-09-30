import { Tabs } from 'expo-router';
import { Building2, Flag, ScrollText, TerminalSquare, UserCog } from 'lucide-react-native';
import { AppTabBar } from '@kit/components/TabBar';
import { colors } from '@kit/theme';

const TABS = {
  home: { label: 'Console', icon: TerminalSquare },
  audit: { label: 'Audit', icon: ScrollText },
  flags: { label: 'Flags', icon: Flag },
  tenants: { label: 'Tenants', icon: Building2 },
  profile: { label: 'Profile', icon: UserCog },
};

export default function TabsLayout() {
  return (
    <Tabs tabBar={(p) => <AppTabBar {...p} tabs={TABS} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}>
      <Tabs.Screen name="home" />
      <Tabs.Screen name="audit" />
      <Tabs.Screen name="flags" />
      <Tabs.Screen name="tenants" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
