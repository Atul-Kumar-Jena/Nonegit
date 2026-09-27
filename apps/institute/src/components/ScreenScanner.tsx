import { useRef } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { X } from 'lucide-react-native';
import { presentCodeFromScan } from '@attendly/protocol';
import { Button, Text } from '@kit/components/ui';
import { colors } from '@kit/theme';

/** Full-screen camera that reads a classroom screen's pairing QR ("ATTENDLY-TV:…"). */
export function ScreenScanner({ open, onClose, onCode }: { open: boolean; onClose: () => void; onCode: (code: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);
  const wrong = useRef(0);
  if (!open) {
    handled.current = false;
    return null;
  }
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.root}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (handled.current) return;
              const code = presentCodeFromScan(data);
              if (!code) {
                wrong.current++;
                return;
              }
              handled.current = true;
              onCode(code);
            }}
          />
        ) : (
          <View style={styles.center}>
            <Text variant="heading" style={{ textAlign: 'center' }}>
              Camera needed
            </Text>
            <Text variant="body" style={{ textAlign: 'center', marginTop: 8 }}>
              To pair, point this phone at the QR code on the classroom screen.
            </Text>
            <Button title={permission?.canAskAgain === false ? 'Open settings to allow the camera' : 'Allow camera'} onPress={() => void requestPermission()} style={{ marginTop: 18 }} />
          </View>
        )}
        <View style={styles.frame} pointerEvents="none" />
        <View style={styles.top}>
          <Text variant="bodyStrong" style={{ flex: 1 }}>
            Point at the QR on the classroom screen
          </Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close scanner" hitSlop={12} style={styles.close}>
            <X color={colors.text} size={20} />
          </Pressable>
        </View>
        <Text variant="small" style={styles.hint}>
          It’s the QR next to “Show attendance on this screen”. Nothing is approved until you confirm on the next step.
        </Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  frame: { position: 'absolute', alignSelf: 'center', top: '28%', width: 250, height: 250, borderRadius: 28, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' },
  top: { position: 'absolute', top: 48, left: 20, right: 20, flexDirection: 'row', alignItems: 'center', gap: 12 },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  hint: { position: 'absolute', bottom: 60, left: 28, right: 28, textAlign: 'center', color: '#d4d4d4' },
});
