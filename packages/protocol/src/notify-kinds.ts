/**
 * Notification categories: one look per kind of news, shared by the server (push thumbnails) and
 * the apps (the notification list), so a notification looks the same everywhere.
 */
export type NotificationCategory = 'class' | 'notice' | 'attendance' | 'request' | 'phone' | 'security';

export const NOTIFICATION_CATEGORIES: Record<NotificationCategory, { label: string; color: string }> = {
  class: { label: 'Classes', color: '#60a5fa' },
  notice: { label: 'Notices', color: '#c084fc' },
  attendance: { label: 'Attendance', color: '#4ade80' },
  request: { label: 'Requests', color: '#fbbf24' },
  phone: { label: 'Phone', color: '#22d3ee' },
  security: { label: 'Security', color: '#f87171' },
};

export function notificationCategory(kind: string): NotificationCategory {
  switch (kind) {
    case 'notice':
      return 'notice';
    case 'attendance':
      return 'attendance';
    case 'request':
    case 'cover':
      return 'request';
    case 'device':
    case 'device_request':
    case 'mentor':
      return 'phone';
    case 'security':
    case 'access':
      return 'security';
    default:
      return 'class'; // timetable changes, reminders, extra / cancelled / moved classes
  }
}
