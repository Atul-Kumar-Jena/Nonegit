import { Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

export interface BiometricSupport {
  available: boolean;
  label: string; // "Face ID", "Touch ID", "Fingerprint", "Biometrics"
  /** The phone has a PIN / pattern / password (with or without biometrics): it can guard the app. */
  screenLock: boolean;
}

export async function biometricSupport(): Promise<BiometricSupport> {
  if (Platform.OS === 'web') return { available: false, label: 'Biometrics', screenLock: false };
  try {
    const [hw, enrolled, types, level] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
      LocalAuthentication.getEnrolledLevelAsync().catch(() => LocalAuthentication.SecurityLevel.NONE),
    ]);
    const face = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);
    const finger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
    const label = Platform.OS === 'ios' ? (face ? 'Face ID' : 'Touch ID') : finger ? 'Fingerprint' : face ? 'Face unlock' : 'Biometrics';
    return { available: hw && enrolled, label, screenLock: level !== LocalAuthentication.SecurityLevel.NONE };
  } catch {
    return { available: false, label: 'Biometrics', screenLock: false };
  }
}

/**
 * Every fingerprint / PIN prompt in the app goes through here, so the app lock can tell that the app
 * left the foreground because of our own prompt (Android's PIN screen is a separate window) and
 * not relock on the way back.
 */
let inFlight = 0;
let lastEndedAt = 0;
export function authPromptBusy(): boolean {
  return inFlight > 0 || Date.now() - lastEndedAt < 1500;
}
export async function authenticate(opts: LocalAuthentication.LocalAuthenticationOptions): Promise<LocalAuthentication.LocalAuthenticationResult> {
  inFlight++;
  try {
    return await LocalAuthentication.authenticateAsync(opts);
  } finally {
    inFlight--;
    lastEndedAt = Date.now();
  }
}

export async function confirmWithBiometrics(reason: string): Promise<boolean> {
  try {
    const r = await authenticate({ promptMessage: reason, cancelLabel: 'Cancel', disableDeviceFallback: false });
    return r.success;
  } catch {
    return false;
  }
}
