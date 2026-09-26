import { memo, useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { create } from 'qrcode/lib/core/qrcode';

/** Pure-JS QR renderer (no network, no native module): encodes `value` and draws it as one SVG path. */
export const QrCode = memo(function QrCode({ value, size }: { value: string; size: number }) {
  const { d, n } = useMemo(() => {
    const m = create(value, { errorCorrectionLevel: 'M' }).modules;
    let path = '';
    for (let r = 0; r < m.size; r++) {
      for (let c = 0; c < m.size; c++) {
        if (!m.get(r, c)) continue;
        // Merge horizontal runs to keep the path short.
        let run = 1;
        while (c + run < m.size && m.get(r, c + run)) run++;
        path += `M${c + 4} ${r + 4}h${run}v1h-${run}z`;
        c += run - 1;
      }
    }
    return { d: path, n: m.size + 8 };
  }, [value]);
  return (
    <View accessible accessibilityLabel="Attendance QR code" style={{ width: size, height: size, backgroundColor: '#ffffff', borderRadius: 16, overflow: 'hidden' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${n} ${n}`}>
        <Rect x={0} y={0} width={n} height={n} fill="#ffffff" />
        <Path d={d} fill="#000000" />
      </Svg>
    </View>
  );
});
