import { Fragment, useMemo } from 'react';
import { Alert, Linking, Platform, StyleSheet, Text as RNText, View, type TextStyle } from 'react-native';
import { parseRich, type Inline } from '@attendly/protocol';
import { colors, fonts } from '../theme';

/** Opens a link from a notice — after showing where it goes (links in notices come from people). */
function openLink(href: string) {
  let host = href;
  try {
    host = new URL(href).host;
  } catch {
    /* shown as is */
  }
  if (Platform.OS === 'web') {
    void Linking.openURL(href);
    return;
  }
  Alert.alert('Open link?', host, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open', onPress: () => void Linking.openURL(href).catch(() => undefined) },
  ]);
}

function Runs({ inlines, base }: { inlines: Inline[]; base: TextStyle }) {
  return (
    <>
      {inlines.map((r, i) => {
        const style: TextStyle[] = [base];
        if (r.b) style.push({ fontFamily: fonts.bold });
        if (r.i) style.push({ fontStyle: 'italic' });
        if (r.s) style.push({ textDecorationLine: 'line-through', color: colors.textMuted });
        if (r.code) style.push(styles.code);
        if (r.href) style.push(styles.link);
        return (
          <RNText key={i} style={style} onPress={r.href ? () => openLink(r.href!) : undefined} accessibilityRole={r.href ? 'link' : undefined} suppressHighlighting={false}>
            {r.text}
          </RNText>
        );
      })}
    </>
  );
}

/** A formatted notice body (see protocol/richtext.ts). `size` scales everything for previews. */
export function RichText({ source, size = 16 }: { source: string; size?: number }) {
  const blocks = useMemo(() => parseRich(source), [source]);
  const body: TextStyle = { fontFamily: fonts.regular, fontSize: size, lineHeight: Math.round(size * 1.55), color: colors.text };
  return (
    <View>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'gap':
            return <View key={i} style={{ height: size * 0.6 }} />;
          case 'hr':
            return <View key={i} style={styles.hr} />;
          case 'h1':
            return (
              <RNText key={i} style={[body, styles.h1, { fontSize: size * 1.35, lineHeight: size * 1.8 }]} accessibilityRole="header">
                <Runs inlines={b.inlines} base={{ fontFamily: fonts.bold }} />
              </RNText>
            );
          case 'h2':
            return (
              <RNText key={i} style={[body, styles.h2, { fontSize: size * 1.12, lineHeight: size * 1.6 }]} accessibilityRole="header">
                <Runs inlines={b.inlines} base={{ fontFamily: fonts.semibold }} />
              </RNText>
            );
          case 'quote':
            return (
              <View key={i} style={styles.quote}>
                <RNText style={[body, { color: colors.textMuted, fontStyle: 'italic' }]}>
                  <Runs inlines={b.inlines} base={{}} />
                </RNText>
              </View>
            );
          case 'li':
          case 'ol':
            return (
              <View key={i} style={styles.item}>
                <RNText style={[body, styles.marker, { minWidth: size * 1.4 }]}>{b.type === 'li' ? '•' : `${b.n}.`}</RNText>
                <RNText style={[body, { flex: 1 }]}>
                  <Runs inlines={b.inlines} base={{}} />
                </RNText>
              </View>
            );
          default:
            return (
              <Fragment key={i}>
                <RNText style={body}>
                  <Runs inlines={b.inlines} base={{}} />
                </RNText>
              </Fragment>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  h1: { marginTop: 6, marginBottom: 2, letterSpacing: -0.3 },
  h2: { marginTop: 4, marginBottom: 1 },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.borderHi, paddingLeft: 12, marginVertical: 4 },
  item: { flexDirection: 'row', paddingLeft: 4 },
  marker: { color: colors.textMuted },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderHi, marginVertical: 12 },
  code: { fontFamily: fonts.mono, backgroundColor: colors.bgRaised, fontSize: 14 },
  link: { textDecorationLine: 'underline', color: colors.text },
});

