/**
 * Timetable-change notifications, shared by both apps:
 *  • in the app: the bell, the list, "mark as read" (normal signed API);
 *  • on the phone: a system notification for each new change, raised while the
 *    app is open and by a background check about every 15 minutes when it isn't.
 *
 * The background check is signed by the device key only and is read-only, so it
 * never uses (or refreshes) login tokens — it can't log anyone out by racing the app.
 * Every native call is best-effort: notifications must never crash the app.
 */
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { z } from 'zod';
import { NotificationsResponse, OkResponse, type AppNotification } from '@attendly/protocol';

const PushTokenResponse = z.object({ ok: z.literal(true), push: z.boolean() });
import { ApiClient } from './api-core';
import { deviceKeys } from './device-key';
import { StorageKeys, getItem } from './storage';
import { loadServerConfig } from './server-config';
import { tokenStore } from './tokens';
import { vault } from './vault';
import { useSession, type NotificationTarget } from '../state/session';

const isWeb = Platform.OS === 'web';
/** High-importance channel: heads-up banner, the phone's default sound, vibration, shown on the lock screen. */
const CHANNEL = 'timetable-alerts';
const SEEN_KEY = 'notify.last-announced.v1';
/** Set when the server pushes to this phone through Firebase (then the app doesn't raise duplicates). */
const PUSH_KEY = 'notify.push-active.v1';

/** What a notification is about: the class, the course, or a request. */
export function targetOf(n: Pick<AppNotification, 'kind' | 'data'>): NotificationTarget {
  const first = (n.data.changes as { sessionId?: string | null; courseId?: string }[] | undefined)?.[0];
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return { kind: n.kind, sessionId: first?.sessionId ?? str(n.data.sessionId), courseId: first?.courseId ?? str(n.data.courseId), requestId: str(n.data.requestId), noticeId: str(n.data.noticeId), batchId: str(n.data.batchId) };
}
export const NOTIFICATION_TASK = 'attendly-notification-check';
export const notificationsKey = ['notifications'] as const;

// ───────────────────────────── in-app list ─────────────────────────────

export function useNotifications() {
  const { api, phase } = useSession();
  return useQuery({
    queryKey: notificationsKey,
    queryFn: () => api!.authed('GET', '/v1/notifications?limit=50', NotificationsResponse),
    enabled: !!api && phase === 'signed-in',
    // While the app is open, news shows up within seconds.
    refetchInterval: 15_000,
  });
}

export function useMarkRead() {
  const { api } = useSession();
  const qc = useQueryClient();
  return async (ids: number[] | 'all') => {
    if (!api) return;
    // Optimistic: the badge clears at once; the server call follows.
    qc.setQueryData<NotificationsResponse>(notificationsKey, (cur) =>
      cur
        ? {
            unread: ids === 'all' ? 0 : Math.max(0, cur.unread - cur.items.filter((i) => !i.read && ids.includes(i.id)).length),
            items: cur.items.map((i) => (ids === 'all' || ids.includes(i.id) ? { ...i, read: true } : i)),
          }
        : cur,
    );
    try {
      await api.authed('POST', '/v1/notifications/read', OkResponse, ids === 'all' ? { all: true } : { ids });
    } catch {
      void qc.invalidateQueries({ queryKey: notificationsKey });
    }
    if (!isWeb) void Notifications.setBadgeCountAsync(0).catch(() => undefined);
  };
}

// ───────────────────────────── phone notifications ─────────────────────────────

let handlerSet = false;
/** Call once at startup (module scope of the app entry). */
export function initPhoneNotifications(): void {
  if (isWeb || handlerSet) return;
  handlerSet = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
    });
    TaskManager.defineTask(NOTIFICATION_TASK, async () => {
      try {
        await backgroundCheck();
        return BackgroundTask.BackgroundTaskResult.Success;
      } catch {
        return BackgroundTask.BackgroundTaskResult.Failed;
      }
    });
  } catch {
    // Missing native module (e.g. an old build): the in-app list still works.
  }
}

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Class changes',
    description: 'Moved, cancelled, substituted and extra classes',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    enableVibrate: true,
    vibrationPattern: [0, 300, 200, 300],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    showBadge: true,
  });
}

/** Schedules the background check (only once notifications are allowed). */
export async function ensureBackgroundCheck(): Promise<void> {
  if (isWeb) return;
  try {
    await ensureChannel();
    if ((await Notifications.getPermissionsAsync()).status !== 'granted') return;
    if (!(await TaskManager.isTaskRegisteredAsync(NOTIFICATION_TASK))) await BackgroundTask.registerTaskAsync(NOTIFICATION_TASK, { minimumInterval: 15 });
  } catch {
    // best effort
  }
}

/** Asks for permission (Android 13+ / iOS) and schedules the background check. */
export async function enablePhoneNotifications(): Promise<'granted' | 'denied' | 'unavailable'> {
  if (isWeb) return 'unavailable';
  try {
    await ensureChannel();
    let status = (await Notifications.getPermissionsAsync()).status;
    // (After a first grant the runner registers this phone for instant push.)
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: true } })).status;
    if (status !== 'granted') return 'denied';
    await ensureBackgroundCheck();
    return 'granted';
  } catch {
    return 'unavailable';
  }
}

export async function phoneNotificationStatus(): Promise<'granted' | 'denied' | 'unavailable'> {
  if (isWeb) return 'unavailable';
  try {
    const s = (await Notifications.getPermissionsAsync()).status;
    return s === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** Raises a phone notification for each item newer than the last one announced. */
export async function announceNew(items: AppNotification[], unread: number): Promise<void> {
  if (isWeb) return;
  try {
    const last = (await vault.get<number>(SEEN_KEY, (v) => (typeof v === 'number' ? v : 0))) ?? null;
    const fresh = items.filter((i) => !i.read && (last === null ? false : i.id > last)).sort((a, b) => a.id - b.id);
    const maxId = Math.max(last ?? 0, ...items.map((i) => i.id));
    // First run on this phone: remember where we are instead of replaying history.
    if (maxId > (last ?? 0) || last === null) await vault.set(SEEN_KEY, maxId);
    if (!fresh.length) return;
    if (await vault.get<boolean>(PUSH_KEY, (v) => v === true)) return; // Firebase already buzzed the phone
    if ((await Notifications.getPermissionsAsync()).status !== 'granted') return;
    // Several at once become one summary; a newer update about the same thing replaces the older one.
    const shown = fresh.length > 3 ? [{ id: fresh.at(-1)!.id, title: `${fresh.length} new updates`, body: fresh.map((f) => f.title).join(' · ') }] : fresh;
    for (const n of shown) {
      const t = 'kind' in n ? targetOf(n as AppNotification) : null;
      const about = t?.noticeId ?? t?.requestId ?? t?.sessionId;
      await Notifications.scheduleNotificationAsync({
        identifier: t ? (about ? `${t.kind}:${about}` : `n:${n.id}`) : 'attendly-summary',
        content: {
          title: n.title,
          body: n.body,
          data: { notificationId: n.id, ...('kind' in n ? targetOf(n as AppNotification) : {}) },
          sound: 'default',
          priority: Notifications.AndroidNotificationPriority.MAX,
          ...(Platform.OS === 'ios' ? { badge: unread } : {}),
        },
        trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
      });
    }
  } catch {
    // never fatal
  }
}

/** The background check: device-key signed, read-only, never touches login tokens. */
async function backgroundCheck(): Promise<void> {
  const [cfg, tokens, key] = await Promise.all([loadServerConfig(), tokenStore.get(), getItem(StorageKeys.deviceKey)]);
  if (!cfg || !tokens || !key) return; // not set up or signed out: nothing to check
  const client = new ApiClient({ baseUrl: cfg.url, keys: deviceKeys, tokens: tokenStore, timeoutMs: 20_000 });
  const offset = await vault.get<number>('clock.offset.v1', (v) => (typeof v === 'number' ? v : NaN));
  if (offset !== null && Number.isFinite(offset)) client.setClockOffset(offset);
  const after = (await vault.get<number>(SEEN_KEY, (v) => (typeof v === 'number' ? v : 0))) ?? 0;
  const res = await client.keySigned(`/v1/notifications/poll?after=${after}`, NotificationsResponse);
  await announceNew(res.items, res.unread);
}

/**
 * Keeps phone notifications flowing while the app is open: announces anything new
 * that the in-app list fetches, and refreshes when the app comes to the foreground.
 */
/** Registers this phone for instant (Firebase) notifications, if the build and the server support it. */
async function registerPush(api: ApiClient): Promise<void> {
  if (isWeb) return;
  try {
    if ((await Notifications.getPermissionsAsync()).status !== 'granted') return;
    const t = await Notifications.getDevicePushTokenAsync();
    if (typeof t.data !== 'string') return;
    const r = await api.authed('POST', '/v1/me/push-token', PushTokenResponse, { token: t.data, platform: Platform.OS === 'ios' ? 'ios' : 'android' });
    await vault.set(PUSH_KEY, r.push);
  } catch {
    // No Firebase in this build, or offline: the app's own checks deliver instead.
    await vault.set(PUSH_KEY, false).catch(() => undefined);
  }
}

export function NotificationRunner() {
  const { phase, api, audience } = useSession();
  const qc = useQueryClient();
  const q = useNotifications();
  const data = q.data;
  const newest = data?.items[0]?.id ?? null;
  useEffect(() => {
    if (data) void announceNew(data.items, data.unread);
  }, [data]);
  // Something changed in the timetable: refresh every screen so it shows the new schedule.
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (newest === null) return;
    if (seen.current !== null && newest > seen.current) void qc.invalidateQueries({ predicate: (query) => query.queryKey[0] !== notificationsKey[0] });
    seen.current = newest;
  }, [newest, qc]);
  // Tapping a phone notification opens what it is about.
  useEffect(() => {
    if (isWeb) return;
    const open = (data: unknown) => {
      const d = (data ?? {}) as NotificationTarget;
      const route = audience.routeFor?.(d) ?? (d.kind === 'request' ? audience.requestsRoute : null) ?? '/notifications';
      setTimeout(() => router.push(route as never), 300);
    };
    let sub: { remove(): void } | null = null;
    try {
      sub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data));
      void Notifications.getLastNotificationResponseAsync()
        .then((r) => {
          if (r && Date.now() - r.notification.date < 60_000) open(r.notification.request.content.data);
        })
        .catch(() => undefined);
    } catch {
      // no native module
    }
    return () => sub?.remove();
  }, [audience]);
  useEffect(() => {
    if (phase === 'signed-in' && api) void registerPush(api);
  }, [phase, api]);
  useEffect(() => {
    if (phase !== 'signed-in') return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void q.refetch();
    });
    return () => sub.remove();
  }, [phase, q.refetch]);
  return null;
}

/**
 * First time the home screen opens after sign-in (on a phone): show the
 * permissions screen once. Afterwards just keep the background check scheduled.
 */
export function usePermissionsOnboarding() {
  const { phase } = useSession();
  useEffect(() => {
    if (isWeb || phase !== 'signed-in') return;
    void (async () => {
      try {
        const done = await vault.get<boolean>('perms.onboarded.v1', (v) => v === true);
        if (!done) router.push('/permissions');
        else await ensureBackgroundCheck();
      } catch {
        // best effort
      }
    })();
  }, [phase]);
}

export async function markPermissionsOnboarded(): Promise<void> {
  await vault.set('perms.onboarded.v1', true).catch(() => undefined);
}
