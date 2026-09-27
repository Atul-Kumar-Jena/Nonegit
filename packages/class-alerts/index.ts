/**
 * Class alerts (Android): at the chosen time before a class, a pinned notification with a live
 * countdown to its start and a "Got it" button. Elsewhere `available` is false and the app keeps
 * its ordinary reminders.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export interface ClassAlert {
  id: string;
  /** When the alert appears (ms since epoch). */
  fireAt: number;
  /** When the class starts: the countdown runs to this (ms since epoch). */
  startsAt: number;
  title: string;
  body: string;
}

interface Native {
  replaceAll(alerts: ClassAlert[]): number;
  count(): number;
  preview(title: string, body: string, startsAt: number): boolean;
}

const native = requireOptionalNativeModule<Native>('AttendlyClassAlerts');

export const classAlerts = {
  available: !!native,
  replaceAll: (alerts: ClassAlert[]) => (native ? native.replaceAll(alerts) : 0),
  count: () => (native ? native.count() : 0),
  preview: (title: string, body: string, startsAt: number) => (native ? native.preview(title, body, startsAt) : false),
};
