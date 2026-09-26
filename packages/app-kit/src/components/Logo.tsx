import { View } from 'react-native';
import { colors, fonts } from '../theme';
import { Text } from './ui';

/** The Attendly mark: a 2×2 grid of squares with the last one a dot (the marked student). */
export function LogoMark({ size = 44, withName = false }: { size?: number; withName?: boolean }) {
  const cell = size * 0.38;
  const gap = size * 0.12;
  const sq = (dot = false) => (
    <View style={{ width: cell, height: cell, borderRadius: dot ? cell / 2 : cell * 0.22, backgroundColor: colors.text, transform: dot ? [{ scale: 0.78 }] : undefined }} />
  );
  const mark = (
    <View style={{ width: size, height: size, justifyContent: 'center', gap }} accessibilityLabel="Attendly">
      <View style={{ flexDirection: 'row', gap, justifyContent: 'center' }}>
        {sq()}
        {sq()}
      </View>
      <View style={{ flexDirection: 'row', gap, justifyContent: 'center' }}>
        {sq()}
        {sq(true)}
      </View>
    </View>
  );
  if (!withName) return <View style={{ alignSelf: 'flex-start' }}>{mark}</View>;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: size * 0.3, alignSelf: 'flex-start' }}>
      {mark}
      <Text style={{ fontFamily: fonts.bold, fontSize: size * 0.62, letterSpacing: -0.8, color: colors.text }}>Attendly</Text>
    </View>
  );
}
