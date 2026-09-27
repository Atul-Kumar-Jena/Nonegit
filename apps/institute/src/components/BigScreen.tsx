import { useEffect, useState } from 'react';
import { StyleSheet, View, Share } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, MonitorX, ScanLine, ShieldCheck } from 'lucide-react-native';
import { normalizePresentCode, type PresentScreen } from '@attendly/protocol';
import { Button, Card, Input, Notice, Text } from '@kit/components/ui';
import { timeAgo } from '@kit/lib/format';
import { displayHost } from '@kit/lib/server-config';
import { useApi, useSession } from '@kit/state/session';
import { colors, fonts } from '@kit/theme';
import { staffApi } from '@/api';
import { Sheet, confirmAction } from './forms';
import { ScreenScanner } from './ScreenScanner';

/** "KXF7M2" → "KXF7-M2" while typing. */
function format(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

export function useScreens(sessionId: string, enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['staff', 'screens', sessionId], queryFn: () => staffApi.screens(api, sessionId), enabled, refetchInterval: enabled ? 15_000 : false });
}

/**
 * Show this class's QR on a laptop / smartboard, GitHub-device-login style:
 * the screen shows a code, the teacher types it here, checks which browser asked,
 * and approves. The screen then gets the rotating QR (never the class key).
 */
export function BigScreenSheet({ sessionId, courseLabel, open, onClose }: { sessionId: string; courseLabel: string; open: boolean; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const { server } = useSession();
  const screens = useScreens(sessionId, open);
  const [code, setCode] = useState('');
  const [found, setFound] = useState<PresentScreen | null>(null);
  const [busy, setBusy] = useState<null | 'find' | 'approve' | string>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!open) {
      setCode('');
      setFound(null);
      setError(null);
      setDone(null);
    }
  }, [open]);

  const host = server ? displayHost(server.url) : 'your Attendly server';
  const normalized = normalizePresentCode(code);

  async function find(c = normalized) {
    if (!c) return;
    setBusy('find');
    setError(null);
    setDone(null);
    try {
      setFound(await staffApi.presentLookup(api, c));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t find that screen.');
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!normalized || !found || busy) return;
    setBusy('approve');
    setError(null);
    try {
      const list = await staffApi.connectScreen(api, sessionId, normalized);
      qc.setQueryData(['staff', 'screens', sessionId], list);
      setDone(`${found.device} now shows the ${courseLabel} QR.`);
      setFound(null);
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t connect the screen.');
    } finally {
      setBusy(null);
    }
  }

  function disconnect(s: PresentScreen) {
    confirmAction('Disconnect this screen?', `${s.device} stops showing the QR immediately.`, 'Disconnect', async () => {
      setBusy(s.id);
      try {
        qc.setQueryData(['staff', 'screens', sessionId], await staffApi.disconnectScreen(api, sessionId, s.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Couldn’t disconnect.');
      } finally {
        setBusy(null);
      }
    }, true);
  }

  return (
    <Sheet open={open} onClose={onClose} title="Show on a big screen" scroll>
      <Text variant="label">1 · On the classroom computer</Text>
      <Text variant="small" style={{ marginTop: 4 }}>
        Open this address in any browser (projector PC, laptop, smartboard):
      </Text>
      <Card style={{ marginTop: 8, paddingVertical: 12, gap: 10 }}>
        <Text style={styles.url} selectable>
          {host}/tv
        </Text>
        <Button
          title="Send the link (WhatsApp, email…)"
          kind="secondary"
          compact
          onPress={() => void Share.share({ message: `${server?.url ?? `https://${host}`}/tv` }).catch(() => undefined)}
        />
      </Card>
      <Text variant="small" style={{ marginTop: 6 }}>
        It shows a pairing QR and an 8-character code. (On a free server the first load can take up to a minute.)
      </Text>

      <Text variant="label" style={{ marginTop: 16 }}>
        2 · Pair this phone
      </Text>
      <Button title="Scan the screen" onPress={() => setScanning(true)} icon={<ScanLine color={colors.bg} size={18} />} style={{ marginTop: 8 }} />
      <Text variant="small" style={{ marginTop: 10 }}>
        or type the code:
      </Text>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
        <View style={{ flex: 1 }}>
          <Input
            value={code}
            onChangeText={(t) => {
              setCode(format(t));
              setFound(null);
              setError(null);
            }}
            placeholder="KXF7-M2QD"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={9}
            style={styles.codeInput}
            accessibilityLabel="Screen code"
            onSubmitEditing={() => void find()}
          />
        </View>
        <Button title="Find" compact onPress={() => void find()} loading={busy === 'find'} disabled={!normalized} />
      </View>

      {found ? (
        <Card tone="cyan" style={{ marginTop: 12, gap: 10 }}>
          <View style={styles.row}>
            <Monitor color={colors.cyan} size={20} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{found.device}</Text>
              <Text variant="small">
                {found.ip ? `from ${found.ip} · ` : ''}asked {timeAgo(found.requestedAt)}
              </Text>
            </View>
          </View>
          <Text variant="small" color={colors.text}>
            Only approve if this is the screen in front of you. It will show the {courseLabel} QR until the class ends or you disconnect it.
          </Text>
          <Button title="3 · Approve & show QR" onPress={() => void approve()} loading={busy === 'approve'} icon={<ShieldCheck color={colors.bg} size={16} />} />
        </Card>
      ) : null}
      {done ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="green" message={done} onDismiss={() => setDone(null)} />
        </View>
      ) : null}
      {error ? (
        <View style={{ marginTop: 12 }}>
          <Notice tone="red" message={error} />
        </View>
      ) : null}

      {(screens.data ?? []).length ? (
        <View style={{ marginTop: 16, gap: 8 }}>
          <Text variant="label">Connected screens</Text>
          {(screens.data ?? []).map((s) => (
            <View key={s.id} style={styles.screen}>
              <Monitor color={colors.green} size={18} />
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong">{s.device}</Text>
                <Text variant="small">
                  {[s.ip, s.approvedBy ? `approved by ${s.approvedBy}` : null, s.approvedAt ? timeAgo(s.approvedAt) : null].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <Button title="Disconnect" kind="danger" compact onPress={() => disconnect(s)} loading={busy === s.id} icon={<MonitorX color={colors.red} size={14} />} />
            </View>
          ))}
        </View>
      ) : null}
      {screens.isError && !screens.data ? (
        <Text variant="small" style={{ marginTop: 12 }}>
          Connecting a screen needs internet on this phone. Without it, show the QR from this phone instead.
        </Text>
      ) : null}
      <ScreenScanner
        open={scanning}
        onClose={() => setScanning(false)}
        onCode={(c) => {
          setScanning(false);
          setCode(format(c));
          void find(c);
        }}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  url: { fontFamily: fonts.monoMedium, fontSize: 16, color: colors.text },
  codeInput: { fontFamily: fonts.monoMedium, fontSize: 20, letterSpacing: 3 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  screen: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
});
