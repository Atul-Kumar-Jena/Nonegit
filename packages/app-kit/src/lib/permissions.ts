/**
 * The permissions each app needs, described in plain words: why it's needed,
 * and what stops working without it. Apps compose their list from these
 * (the student app adds the camera).
 */
import { Linking, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { enablePhoneNotifications } from './notifications';

export type PermState = 'granted' | 'denied' | 'blocked' | 'unavailable';

export interface PermissionItem {
  key: string;
  title: string;
  why: string;
  /** Shown once if the person says no. */
  ifDenied: string;
  required: boolean;
  check(): Promise<PermState>;
  request(): Promise<PermState>;
}

export function openAppSettings(): void {
  void Linking.openSettings().catch(() => undefined);
}

export function locationPermission(why: string, ifDenied: string): PermissionItem {
  return {
    key: 'location',
    title: 'Location (while using the app)',
    why,
    ifDenied,
    required: true,
    async check() {
      try {
        const p = await Location.getForegroundPermissionsAsync();
        return p.granted ? 'granted' : p.canAskAgain ? 'denied' : 'blocked';
      } catch {
        return 'unavailable';
      }
    },
    async request() {
      try {
        const p = await Location.requestForegroundPermissionsAsync();
        return p.granted ? 'granted' : p.canAskAgain ? 'denied' : 'blocked';
      } catch {
        return 'unavailable';
      }
    },
  };
}

export function notificationPermission(why: string, ifDenied: string): PermissionItem {
  return {
    key: 'notifications',
    title: 'Notifications (with sound)',
    why,
    ifDenied,
    required: false,
    async check() {
      if (Platform.OS === 'web') return 'unavailable';
      try {
        const p = await Notifications.getPermissionsAsync();
        return p.status === 'granted' ? 'granted' : p.canAskAgain ? 'denied' : 'blocked';
      } catch {
        return 'unavailable';
      }
    },
    async request() {
      const r = await enablePhoneNotifications();
      if (r === 'granted' || r === 'unavailable') return r;
      try {
        return (await Notifications.getPermissionsAsync()).canAskAgain ? 'denied' : 'blocked';
      } catch {
        return 'denied';
      }
    },
  };
}
