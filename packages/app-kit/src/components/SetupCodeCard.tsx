import { Share, View } from 'react-native';
import { KeyRound, Share2 } from 'lucide-react-native';
import { formatInstitutionCode, type IssuedSetupCode } from '@attendly/protocol';
import { Button, Card, Text } from './ui';
import { colors, fonts } from '../theme';

/** Step-by-step message to send the person (WhatsApp, SMS…): everything they need for the first sign-in. */
export function setupMessage(s: IssuedSetupCode, opts: { app: string; institution?: string; institutionCode?: string }): string {
  const until = new Date(s.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return [
    `${s.name}, here is your first sign-in for ${opts.app}${opts.institution ? ` (${opts.institution})` : ''}:`,
    `1. Install ${opts.app} and Google Authenticator.`,
    opts.institutionCode ? `2. Open ${opts.app} and enter the institution code ${formatInstitutionCode(opts.institutionCode)}.` : `2. Open ${opts.app}.`,
    `3. Tap “First time? Sign in with a setup code”.`,
    `   Sign-in ID: ${s.signInId}`,
    `   Setup code: ${s.code}  (works once, until ${until})`,
    `4. Add Attendly to Google Authenticator when asked, and type its 6-digit code.`,
    `After that you sign in with your ID and the Google Authenticator code. Keep this code private.`,
  ].join('\n');
}

/** A just-issued setup code: shown once, with a Share button that sends the full instructions. */
export function SetupCodeCard({ issued, app, institution, institutionCode, onDone }: { issued: IssuedSetupCode; app: string; institution?: string; institutionCode?: string; onDone?: () => void }) {
  const until = new Date(issued.expiresAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return (
    <Card tone="green" style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <KeyRound color={colors.green} size={18} />
        <Text variant="bodyStrong" style={{ flex: 1 }}>{`Setup code for ${issued.name}`}</Text>
      </View>
      <Text selectable style={{ fontFamily: fonts.mono, fontSize: 26, letterSpacing: 2, color: colors.text }} accessibilityLabel={`Setup code ${issued.code.split('').join(' ')}`}>
        {issued.code}
      </Text>
      <Text variant="small">{`Sign-in ID: ${issued.signInId}`}</Text>
      <Text variant="small">{`Works once, until ${until}. Shown only now — share it privately. They link Google Authenticator with it; no email is sent.`}</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button
          title="Share instructions"
          onPress={() => void Share.share({ message: setupMessage(issued, { app, institution, institutionCode }) }).catch(() => undefined)}
          icon={<Share2 color={colors.bg} size={15} />}
          style={{ flex: 1 }}
        />
        {onDone ? <Button title="Done" kind="ghost" onPress={onDone} /> : null}
      </View>
    </Card>
  );
}
