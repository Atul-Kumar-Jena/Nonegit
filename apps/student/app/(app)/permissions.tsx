import { useMemo } from 'react';
import { Camera } from 'expo-camera';
import PermissionsScreen from '@kit/screens/PermissionsScreen';
import { locationPermission, notificationPermission, type PermissionItem, type PermState } from '@kit/lib/permissions';

const camera: PermissionItem = {
  key: 'camera',
  title: 'Camera',
  why: 'To read your class’s rotating QR code. Nothing is photographed, recorded or uploaded.',
  ifDenied: 'You won’t be able to scan the class QR, so you can’t mark your own attendance (your teacher would have to mark you by hand).',
  required: true,
  async check(): Promise<PermState> {
    try {
      const p = await Camera.getCameraPermissionsAsync();
      return p.granted ? 'granted' : p.canAskAgain ? 'denied' : 'blocked';
    } catch {
      return 'unavailable';
    }
  },
  async request(): Promise<PermState> {
    try {
      const p = await Camera.requestCameraPermissionsAsync();
      return p.granted ? 'granted' : p.canAskAgain ? 'denied' : 'blocked';
    } catch {
      return 'unavailable';
    }
  },
};

export default function Permissions() {
  const items = useMemo(
    () => [
      camera,
      locationPermission(
        'Only at the moment you scan, to prove you’re inside the classroom. Never in the background, never tracked.',
        'Scans will be refused — the server can’t confirm you’re in the room.',
      ),
      notificationPermission(
        'So you hear (with sound) when a class is moved, cancelled, taken by another teacher, or an extra class is added — even when the app is closed.',
        'You won’t be alerted about timetable changes; you’ll only see them when you open the app.',
      ),
    ],
    [],
  );
  return <PermissionsScreen appName="Attendly" items={items} />;
}
