import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import { BarChart3, Check, CloudUpload, ChevronDown, ChevronRight, Clock, MapPin, ShieldAlert, ShieldX, Smartphone, TriangleAlert, WifiOff, X } from 'lucide-react-native';
import { REJECTION_CODES, type RejectionCode } from '@attendly/protocol';
import { Screen } from '@kit/components/Screen';
import { Badge, Button, Card, IconTile, InfoRow, Text } from '@kit/components/ui';
import { pct, zoned, clock } from '@kit/lib/format';
import { clearScanOutcome, takeScanOutcome, type ScanOutcome } from '@/state/scan-result';
import { colors, fonts, toneColor } from '@kit/theme';

/** 06 · Attendance success  /  07 · Rejected. */
export default function Result() {
  const [outcome] = useState<ScanOutcome | null>(() => takeScanOutcome());
  useEffect(() => () => clearScanOutcome(), []);
  if (!outcome) return <Redirect href="/home" />;
  if (outcome.kind === 'success') return <Success o={outcome} />;
  if (outcome.kind === 'round') return <Round o={outcome} />;
  if (outcome.kind === 'queued') return <Queued label={outcome.label} reason={outcome.reason} />;
  if (outcome.kind === 'rejected') return <Rejected code={outcome.rejection.code} title={outcome.rejection.title} hint={outcome.rejection.hint} detail={outcome.rejection.detail} />;
  return <Failure title={outcome.title} message={outcome.message} />;
}

function Halo({ tone, children }: { tone: 'green' | 'red' | 'amber'; children: ReactNode }) {
  const t = toneColor[tone];
  const solid = tone === 'green' ? ['#34d399', '#10b981'] : tone === 'red' ? ['#f87171', '#ef4444'] : ['#fbbf24', '#f59e0b'];
  return (
    <View style={styles.haloWrap}>
      <View style={[styles.halo, { width: 132, height: 132, borderColor: t.line, opacity: 0.5 }]} />
      <View style={[styles.halo, { width: 104, height: 104, borderColor: t.line }]} />
      <View style={[styles.core, { backgroundColor: solid[0], shadowColor: solid[1] }]}>{children}</View>
    </View>
  );
}

/** Layered scans: one round done — stay for the next one. */
function Round({ o }: { o: Extract<ScanOutcome, { kind: 'round' }> }) {
  const { res } = o;
  const left = res.round.required - res.round.done;
  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 28, alignItems: 'stretch' }}>
      <Halo tone="amber">
        <Check color="#3b2303" size={34} strokeWidth={3} />
      </Halo>
      <Text variant="title" style={styles.center}>
        {`Scan ${res.round.done} of ${res.round.required} recorded`}
      </Text>
      <Text variant="body" style={[styles.center, { marginTop: 6 }]}>
        {`${res.courseCode} · ${res.courseTitle}`}
      </Text>
      <Card tone="amber" style={{ marginTop: 22, gap: 6 }}>
        <Text variant="bodyStrong">{`Not marked present yet — ${left} more ${left === 1 ? 'scan' : 'scans'} to go`}</Text>
        <Text variant="small" color={colors.text}>
          Your professor asked for several scans during this class. Stay until the end: when the next round opens you’ll get a notification — scan the code on screen again. You’re present only after every round.
        </Text>
      </Card>
      {res.offline ? (
        <Text variant="small" style={[styles.center, { marginTop: 10 }]}>
          Saved while offline — counted now.
        </Text>
      ) : null}
      <Button title="Done" onPress={() => router.replace('/home')} style={{ marginTop: 22 }} />
    </Screen>
  );
}

function Success({ o }: { o: Extract<ScanOutcome, { kind: 'success' }> }) {
  const { res, receiptVerified } = o;
  const r = res.record;
  const subtitle = [`${r.courseCode} · ${r.courseTitle}`, r.lectureNo ? `${r.kind === 'lab' ? 'Lab' : 'Lecture'} ${r.lectureNo}` : null].filter(Boolean).join(' · ');
  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 28, alignItems: 'stretch' }}>
      <Halo tone={receiptVerified ? 'green' : 'amber'}>{receiptVerified ? <Check color="#052e1c" size={36} strokeWidth={3} /> : <ShieldAlert color="#3b2303" size={34} />}</Halo>
      <Text variant="title" style={styles.center}>
        {res.alreadyMarked ? 'Already marked' : 'Marked present'}
      </Text>
      <Text variant="body" style={[styles.center, { marginTop: 6 }]}>
        {res.alreadyMarked ? `You were marked present at ${clock(r.markedAt)}. ${subtitle}` : subtitle}
      </Text>

      <Card style={{ marginTop: 22, paddingVertical: 10 }}>
        <InfoRow label="TIME" value={`${clock(r.markedAt)}${r.offline ? ' · saved offline' : ''}`} mono={false} />
        <InfoRow label="DISTANCE" value={`${r.distanceM} m from the room’s centre`} mono={false} />
        <InfoRow label="RECORD" value={receiptVerified ? 'Signed by Attendly ✓' : 'Couldn’t confirm'} valueColor={receiptVerified ? colors.green : colors.amber} mono={false} />
      </Card>

      {!receiptVerified ? (
        <Card tone="amber" style={{ marginTop: 12 }}>
          <Text variant="small" color={colors.text}>
            Your mark was accepted, but this phone couldn’t confirm Attendly’s signature on it. It’s most likely recorded — ask your professor to check it on their screen.
          </Text>
        </Card>
      ) : null}

      <Card style={[styles.row, { marginTop: 12 }]}>
        <IconTile tone="green">
          <BarChart3 color={colors.green} size={18} />
        </IconTile>
        <View style={{ flex: 1 }}>
          <Text variant="small">{r.courseCode} attendance</Text>
          <Text variant="bodyStrong">
            {res.course.before !== null && res.course.before !== res.course.after ? `${pct(res.course.before)}% → ` : ''}
            {pct(res.course.after)}%
          </Text>
        </View>
        <Pressable onPress={() => router.dismissTo('/subjects')} accessibilityRole="button" accessibilityLabel="Open subjects" hitSlop={10}>
          <ChevronRight color={colors.textDim} size={20} />
        </Pressable>
      </Card>

      <Button title="Back to dashboard" onPress={() => router.dismissTo('/home')} style={{ marginTop: 22 }} />
    </Screen>
  );
}

const REASON_ICON: Partial<Record<RejectionCode, typeof MapPin>> = {
  'E-GEO': MapPin,
  'E-GPS-WEAK': MapPin,
  'E-GPS-STALE': MapPin,
  'E-MOCK': ShieldX,
  'E-EXPIRED': Clock,
  'E-DEVICE': Smartphone,
  'E-INTEGRITY': ShieldX,
};

function Rejected({ code, title, hint, detail }: { code: RejectionCode; title: string; hint: string; detail?: string }) {
  const Icon = REASON_ICON[code] ?? TriangleAlert;
  const others = (['E-EXPIRED', 'E-DEVICE', 'E-DUPE', 'E-GEO'] as const).filter((c) => c !== code).slice(0, 3);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 28 }}>
      <Halo tone="red">
        <X color="#3b0a0a" size={36} strokeWidth={3} />
      </Halo>
      <Text variant="title" style={styles.center}>
        Attendance rejected
      </Text>
      <Text variant="body" style={[styles.center, { marginTop: 6 }]}>
        The server refused the mark.{'\n'}See reason below.
      </Text>

      <Card tone="red" style={{ marginTop: 22, gap: 12 }}>
        <View style={styles.row}>
          <IconTile tone="red">
            <Icon color={colors.red} size={18} />
          </IconTile>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: fonts.monoMedium, fontSize: 10.5, letterSpacing: 1.4, color: colors.red }}>REJECTION CODE · {code}</Text>
            <Text variant="bodyStrong">{title}</Text>
          </View>
        </View>
        {detail ? (
          <Text variant="body" color={colors.text}>
            {detail}
          </Text>
        ) : null}
        <Badge label={hint} tone="amber" icon={<TriangleAlert color={colors.amber} size={11} />} />
      </Card>

      <Card style={{ marginTop: 12, paddingVertical: 6 }}>
        <Text variant="label" style={{ marginTop: 8, marginBottom: 4 }}>
          Other possible reasons
        </Text>
        {others.map((c, i) => {
          const info = REJECTION_CODES[c];
          const O = REASON_ICON[c] ?? TriangleAlert;
          const expanded = open === c;
          return (
            <Pressable
              key={c}
              onPress={() => setOpen(expanded ? null : c)}
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              style={[styles.reason, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
            >
              <View style={styles.row}>
                <O color={colors.textMuted} size={17} />
                <Text variant="body" style={{ flex: 1 }}>
                  {info.title}
                </Text>
                {expanded ? <ChevronDown color={colors.textDim} size={16} /> : <ChevronRight color={colors.textDim} size={16} />}
              </View>
              {expanded ? (
                <Text variant="small" style={{ marginTop: 6, marginLeft: 29 }}>
                  {info.hint}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </Card>

      <View style={{ gap: 10, marginTop: 22 }}>
        {code === 'E-PAUSED' || code === 'E-NOT-ENROLLED' || code === 'E-SESSION-CLOSED' || code === 'E-REVOKED' ? null : <Button title="Scan again" onPress={() => router.replace('/scan')} />}
        <Button title="Back to dashboard" kind="secondary" onPress={() => router.dismissTo('/home')} />
      </View>
    </Screen>
  );
}

function Queued({ label, reason }: { label: string; reason: 'offline' | 'not-started' }) {
  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 28 }}>
      <Halo tone="amber">
        <CloudUpload color="#3b2303" size={32} />
      </Halo>
      <Text variant="title" style={styles.center}>
        {reason === 'offline' ? 'Saved offline' : 'Saved — waiting for class'}
      </Text>
      <Text variant="body" style={[styles.center, { marginTop: 6 }]}>
        {label}
      </Text>
      <Card style={{ marginTop: 20, gap: 8 }}>
        <Text variant="body" color={colors.text}>
          {reason === 'offline'
            ? 'You’re offline, so your scan was sealed and stored on this phone. It uploads by itself as soon as you’re back online — keep the app installed and stay signed in.'
            : 'Your instructor’s phone hasn’t synced this class yet (it may be offline). Your scan is stored on this phone and is submitted automatically once the class appears on the server.'}
        </Text>
        <Text variant="small">
          The server still checks the code, your location and the time you scanned. Upload within 24 hours. You’ll see the result on the home screen.
        </Text>
      </Card>
      <View style={{ gap: 10, marginTop: 22 }}>
        <Button title="Back to dashboard" onPress={() => router.dismissTo('/home')} />
      </View>
    </Screen>
  );
}

function Failure({ title, message }: { title: string; message: string }) {
  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 28 }}>
      <Halo tone="amber">
        <WifiOff color="#3b2303" size={32} />
      </Halo>
      <Text variant="title" style={styles.center}>
        {title}
      </Text>
      <Card style={{ marginTop: 20 }}>
        <Text variant="body">{message}</Text>
      </Card>
      <View style={{ gap: 10, marginTop: 22 }}>
        <Button title="Scan again" onPress={() => router.replace('/scan')} />
        <Button title="Back to dashboard" kind="secondary" onPress={() => router.dismissTo('/home')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  haloWrap: { alignSelf: 'center', width: 140, height: 140, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  halo: { position: 'absolute', borderRadius: 999, borderWidth: 1 },
  core: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', shadowOpacity: 0.6, shadowRadius: 22, shadowOffset: { width: 0, height: 0 }, elevation: 10 },
  reason: { paddingVertical: 13 },
});
