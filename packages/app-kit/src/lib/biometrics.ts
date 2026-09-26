import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

export interface BiometricSupport {
  available: boolean;
  label: string; // "Face ID", "Touch ID", "Fingerprint", "Biometrics"
}

export async function biometricSupport(): Promise<BiometricSupport> {
  if (Platform.OS === 'web') return { available: false, label: 'Biometrics' };
  try {
    const [hw, enrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    const finger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
    const label = Platform.OS === 'ios' ? (face ? 'Face ID' : 'Touch ID') : finger ? 'Fingerprint' : face ? 'Face unlock' : 'Biometrics';
    return { available: hw && enrolled, label };
  } catch {
    return { available: false, label: 'Biometrics' };
  }
}

export async function confirmWithBiometrics(reason: string): Promise<boolean> {
  try {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: 'Cancel', disableDeviceFallback: false });
    return r.success;
  } catch {
    return false;
  }
}
