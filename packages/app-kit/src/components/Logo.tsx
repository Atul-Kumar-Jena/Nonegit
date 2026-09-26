import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { ShieldCheck } from 'lucide-react-native';
import { gradients } from '../theme';

export function LogoMark({ size = 44 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.28, alignSelf: 'flex-start', shadowColor: '#22d3ee', shadowOpacity: 0.45, shadowRadius: size * 0.45, shadowOffset: { width: 0, height: 0 }, elevation: 8 }}>
      <LinearGradient
        colors={gradients.brand}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ width: size, height: size, borderRadius: size * 0.28, alignItems: 'center', justifyContent: 'center' }}
      >
        <ShieldCheck color="#04141c" size={size * 0.5} strokeWidth={2.2} />
      </LinearGradient>
    </View>
  );
}
