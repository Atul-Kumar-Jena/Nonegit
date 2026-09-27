import { useState } from 'react';
import { View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { ArrowRight, BadgeCheck, Building2, Clock3, KeyRound, ShieldOff } from 'lucide-react-native';
import { formatInstitutionCode, type InstitutionLookup } from '@attendly/protocol';
import { LogoMark } from '../components/Logo';
import { Screen } from '../components/Screen';
import { Button, Card, Input, Notice, Text } from '../components/ui';
import { useSession } from '../state/session';
import { colors, fonts } from '../theme';

/**
 * Institute app, first step: the institution's code (from its admin / Attendly). Shows the
 * institution with its verified mark; only verified, active institutions can continue.
 */
export default function InstitutionScreen() {
  const { server, lookupInstitution, setInstitution, institution } = useSession();
  const [code, setCode] = useState('');
  const [found, setFound] = useState<InstitutionLookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!server) return <Redirect href="/server" />;
  if (institution) return <Redirect href="/login" />;

  async function find(raw = code) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      setFound(await lookupInstitution(raw));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not check that code.');
    } finally {
      setBusy(false);
    }
  }

  const demoCode = server.demo?.institutionCode ?? null;
  const usable = found && found.verified && found.active;

  return (
    <Screen keyboard contentStyle={{ paddingTop: 28 }}>
      <LogoMark size={30} withName />
      <View style={{ gap: 6, marginTop: 22 }}>
        <Text variant="title">Your institution</Text>
        <Text variant="body">Enter the 8-character code your institution received from Attendly (ask your admin). You only do this once on this phone.</Text>
      </View>

      <Text variant="label" style={{ marginTop: 24, marginBottom: 8 }}>
        Institution code
      </Text>
      <Input
        value={code}
        onChangeText={(t) => {
          setCode(t.toUpperCase());
          setFound(null);
          setError(null);
        }}
        placeholder="7F3A-91C2"
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={12}
        returnKeyType="search"
        onSubmitEditing={() => void find()}
        icon={<KeyRound color={colors.textDim} size={18} />}
        invalid={!!error}
        accessibilityLabel="Institution code"
        style={{ fontFamily: fonts.monoMedium, letterSpacing: 2 }}
      />
      {error ? (
        <View style={{ marginTop: 14 }}>
          <Notice message={error} tone="red" />
        </View>
      ) : null}

      {found ? (
        <Card tone={usable ? 'green' : 'amber'} style={{ marginTop: 16, gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Building2 color={colors.text} size={22} />
            <View style={{ flex: 1 }}>
              <Text variant="heading">{found.name}</Text>
              <Text variant="monoSmall">{formatInstitutionCode(found.code)}</Text>
            </View>
          </View>
          {usable ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <BadgeCheck color={colors.green} size={16} />
              <Text variant="small" color={colors.green}>
                Verified by Attendly
              </Text>
            </View>
          ) : !found.active ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <ShieldOff color={colors.amber} size={16} />
              <Text variant="small" color={colors.amber} style={{ flex: 1 }}>
                This institution is suspended. Contact Attendly.
              </Text>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Clock3 color={colors.amber} size={16} />
              <Text variant="small" color={colors.amber} style={{ flex: 1 }}>
                Waiting for verification by Attendly. You can sign in as soon as it’s verified.
              </Text>
            </View>
          )}
        </Card>
      ) : null}

      {usable ? (
        <Button title={`Continue to ${found.name}`} onPress={() => void setInstitution(found).then(() => router.replace('/login'))} style={{ marginTop: 18 }} icon={<ArrowRight color={colors.bg} size={18} />} />
      ) : (
        <Button title={found && !usable ? 'Check again' : 'Find institution'} onPress={() => void find()} loading={busy} disabled={code.replace(/[\s-]/g, '').length < 8} style={{ marginTop: 18 }} />
      )}

      {demoCode ? (
        <Card style={{ marginTop: 28, gap: 8 }}>
          <Text variant="label">Just trying Attendly?</Text>
          <Text variant="small">{`Use the demo institute${server.demo?.institution ? ` (${server.demo.institution})` : ''} with ready-made accounts — no codes needed.`}</Text>
          <Button
            title={`Try the demo · ${formatInstitutionCode(demoCode)}`}
            kind="secondary"
            compact
            onPress={() => {
              setCode(formatInstitutionCode(demoCode));
              void find(demoCode);
            }}
          />
        </Card>
      ) : null}
    </Screen>
  );
}
