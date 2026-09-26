import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Channel, OtpVerifyResponse, Role, UserSummary } from '@attendly/protocol';
import { ApiClient, ApiRequestError, normalizeBaseUrl } from '../lib/api-core';
import { collectDeviceInfo } from '../lib/device-info';
import { destroyDeviceKey, deviceKeys } from '../lib/device-key';
import { ALLOW_HTTP, DEFAULT_SERVER_URL } from '../lib/env';
import {
  ServerIdentityError,
  checkServerIdentity,
  clearServerConfig,
  loadServerConfig,
  saveServerConfig,
  type ServerConfig,
} from '../lib/server-config';
import { tokenStore } from '../lib/tokens';
import { outbox } from '../lib/outbox';
import { vault } from '../lib/vault';

export type Phase = 'booting' | 'needs-server' | 'signed-out' | 'signed-in' | 'identity-error';

export interface PendingOtp {
  channel: Channel;
  identifier: string;
  challengeId: string;
  destination: string;
  expiresAt: string;
  resendAt: number;
}

export type PendingDevice =
  | { kind: 'bind'; ticket: string; user: UserSummary }
  | Extract<OtpVerifyResponse, { status: 'device_mismatch' }> & { kind: 'mismatch' };

interface SessionValue {
  phase: Phase;
  server: ServerConfig | null;
  api: ApiClient | null;
  notice: string | null;
  identityError: string | null;
  pendingOtp: PendingOtp | null;
  pendingDevice: PendingDevice | null;
  suggestedServerUrl: string;
  connect(url: string): Promise<void>;
  requestOtp(channel: Channel, identifier: string): Promise<PendingOtp>;
  verifyOtp(code: string): Promise<'signed-in' | 'bind' | 'mismatch'>;
  bindDevice(): Promise<void>;
  requestRebind(reason: string): Promise<void>;
  signOut(): Promise<void>;
  resetPhone(): Promise<void>;
  clearNotice(): void;
}

const Ctx = createContext<SessionValue | null>(null);

/** Which people an app is for. Checked right after the code is verified — before any device is bound. */
export interface AppAudience {
  appName: string;
  allowedRoles: readonly Role[];
  /** Shown when someone signs in to the wrong app, e.g. a teacher in the student app. */
  wrongRoleMessage: string;
}

const CLOCK_KEY = 'clock.offset.v1';
let lastClockSave = 0;
function persistClockOffset(offsetMs: number) {
  const t = Date.now();
  if (t - lastClockSave < 60_000) return;
  lastClockSave = t;
  void vault.set(CLOCK_KEY, Math.round(offsetMs)).catch(() => undefined);
}

/** Free-tier servers (e.g. Render) sleep when idle and need up to a minute to wake. */
const CONNECT_TIMEOUT_MS = 75_000;

/** Turns a failed first contact into advice a non-technical person can act on. */
function connectErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'UNREADABLE' || err.code === 'NOT_FOUND' || err.status === 404)
      return 'That address answered, but it is not an Attendly server. Paste the full address of YOUR Attendly server (for example https://attendly-api-xxxx.onrender.com), not a website’s home page.';
    if (err.code === 'BAD_RESPONSE')
      return 'That server’s reply doesn’t match this version of the app. If it is your Attendly server, update the app (or the server); otherwise check the address.';
    if (err.code === 'TIMEOUT') return 'The server did not answer within a minute. Check that it is running (free servers can be slow to wake) and try again.';
    if (err.code === 'NETWORK') return 'Couldn’t reach that address. Check it is typed exactly right, that your phone has internet, and that the server is running.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Could not connect to that server.';
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>');
  return v;
}

/** Convenience for screens that only render when signed in. */
export function useApi(): ApiClient {
  const { api } = useSession();
  if (!api) throw new Error('API client not ready');
  return api;
}

export function SessionProvider({ children, audience }: { children: ReactNode; audience: AppAudience }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('booting');
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [pendingOtp, setPendingOtp] = useState<PendingOtp | null>(null);
  const [pendingDevice, setPendingDevice] = useState<PendingDevice | null>(null);
  const apiRef = useRef<ApiClient | null>(null);
  const [api, setApi] = useState<ApiClient | null>(null);

  const buildClient = useCallback(
    (url: string) =>
      new ApiClient({
        baseUrl: url,
        keys: deviceKeys,
        tokens: tokenStore,
        onClockSync: persistClockOffset,
        onSessionLost: (err) => {
          queryClient.clear();
          setNotice(
            err.code === 'DEVICE_REVOKED'
              ? 'This phone was unbound from your account. Sign in again to bind it.'
              : err.code === 'ACCOUNT_SUSPENDED'
                ? 'Your account is suspended. Contact your institution.'
                : 'Your session ended. Please sign in again.',
          );
          setPhase('signed-out');
        },
      }),
    [queryClient],
  );

  const installClient = useCallback((client: ApiClient) => {
    apiRef.current = client;
    setApi(client);
    // Offline right after launch? Use the last measured clock offset.
    void vault.get<number>(CLOCK_KEY, (v) => (typeof v === 'number' ? v : NaN)).then((o) => o !== null && client.setClockOffset(o));
    return client;
  }, []);

  /** Fetches /v1/meta, enforces the key pin, and stores the server. */
  const connect = useCallback(
    async (rawUrl: string) => {
      const url = normalizeBaseUrl(rawUrl, ALLOW_HTTP);
      const existing = await loadServerConfig();
      // Probe with a throw-away client; it only becomes the app's client once the identity check passes.
      const client = buildClient(url);
      let meta;
      try {
        meta = await client.meta(CONNECT_TIMEOUT_MS);
      } catch (err) {
        throw new Error(connectErrorMessage(err));
      }
      const cfg = checkServerIdentity(url, meta, existing);
      installClient(client);
      if (existing && existing.url !== url) {
        // Switching servers: the old session is meaningless here.
        await tokenStore.clear();
        queryClient.clear();
      }
      await saveServerConfig(cfg);
      setServer(cfg);
      setPhase((await tokenStore.get()) ? 'signed-in' : 'signed-out');
    },
    [buildClient, installClient, queryClient],
  );

  // ── boot ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let cfg = await loadServerConfig();
        if (cancelled) return;
        if (!cfg) {
          if (DEFAULT_SERVER_URL) {
            try {
              await connect(DEFAULT_SERVER_URL);
              return;
            } catch (err) {
              if (err instanceof ServerIdentityError) throw err;
              setNotice(err instanceof Error ? err.message : 'Could not reach the server.');
            }
          }
          setPhase('needs-server');
          return;
        }
        let storedUrl: string;
        try {
          storedUrl = normalizeBaseUrl(cfg.url, ALLOW_HTTP);
        } catch {
          // A stored address this build can't use: start over safely. Its session tokens
          // belong to that server, so they must never be sent anywhere else.
          await tokenStore.clear();
          await clearServerConfig();
          setPhase('needs-server');
          return;
        }
        if (storedUrl !== cfg.url) {
          // Legacy (non-canonical) spelling of the same address: store the canonical form so
          // later identity/pin checks compare like with like.
          cfg = { ...cfg, url: storedUrl };
          await saveServerConfig(cfg);
        }
        setServer(cfg);
        const client = installClient(buildClient(storedUrl));
        setPhase((await tokenStore.get()) ? 'signed-in' : 'signed-out');
        // Background identity check + clock sync; offline is fine.
        client
          .meta()
          .then(async (meta) => {
            const fresh = checkServerIdentity(cfg.url, meta, cfg);
            if (!cancelled && fresh.channels.join() !== cfg.channels.join()) {
              await saveServerConfig(fresh);
              setServer(fresh);
            }
          })
          .catch((err) => {
            if (err instanceof ServerIdentityError && !cancelled) {
              setIdentityError(err.message);
              setPhase('identity-error');
            }
          });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ServerIdentityError) {
          setIdentityError(err.message);
          setPhase('identity-error');
        } else {
          setNotice('Secure storage could not be read. Restart the app; if this persists, reinstall it.');
          setPhase('needs-server');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const requestOtp = useCallback(async (channel: Channel, identifier: string) => {
    const client = apiRef.current;
    if (!client) throw new Error('Choose a server first.');
    const r = await client.requestOtp(channel === 'email' ? { channel, identifier } : { channel, identifier });
    const p: PendingOtp = {
      channel,
      identifier,
      challengeId: r.challengeId,
      destination: r.destination,
      expiresAt: r.expiresAt,
      resendAt: Date.now() + r.resendAfterSec * 1000,
    };
    setPendingOtp(p);
    setNotice(null);
    return p;
  }, []);

  const verifyOtp = useCallback(
    async (code: string) => {
      const client = apiRef.current;
      if (!client || !pendingOtp) throw new Error('Request a new code.');
      const info = await collectDeviceInfo();
      const res = await client.verifyOtp(pendingOtp.challengeId, code, info);
      if (!audience.allowedRoles.includes(res.user.role)) {
        // Wrong app for this account: never bind this phone, and drop any session just issued.
        if (res.status === 'ok') await client.logout().catch(() => tokenStore.clear());
        setPendingOtp(null);
        setPendingDevice(null);
        throw new ApiRequestError('FORBIDDEN', audience.wrongRoleMessage, 403);
      }
      if (res.status === 'ok') {
        setPendingOtp(null);
        setPendingDevice(null);
        queryClient.clear();
        setPhase('signed-in');
        return 'signed-in' as const;
      }
      if (res.status === 'bind_required') {
        setPendingDevice({ kind: 'bind', ticket: res.ticket, user: res.user });
        return 'bind' as const;
      }
      setPendingDevice({ ...res, kind: 'mismatch' });
      return 'mismatch' as const;
    },
    [pendingOtp, queryClient, audience],
  );

  const bindDevice = useCallback(async () => {
    const client = apiRef.current;
    if (!client || pendingDevice?.kind !== 'bind') throw new ApiRequestError('TICKET_INVALID', 'This sign-in step expired. Please sign in again.');
    await client.bind(pendingDevice.ticket);
    setPendingOtp(null);
    setPendingDevice(null);
    queryClient.clear();
    setPhase('signed-in');
  }, [pendingDevice, queryClient]);

  const requestRebind = useCallback(
    async (reason: string) => {
      const client = apiRef.current;
      if (!client || pendingDevice?.kind !== 'mismatch') throw new ApiRequestError('TICKET_INVALID', 'This sign-in step expired. Please sign in again.');
      await client.requestRebind(pendingDevice.ticket, reason);
    },
    [pendingDevice],
  );

  const signOut = useCallback(async () => {
    try {
      await apiRef.current?.logout();
    } catch {
      // Offline or already revoked: local sign-out still proceeds.
      await tokenStore.clear();
    }
    queryClient.clear();
    await outbox.wipe().catch(() => undefined);
    setPendingOtp(null);
    setPendingDevice(null);
    setPhase('signed-out');
  }, [queryClient]);

  const resetPhone = useCallback(async () => {
    try {
      await apiRef.current?.logout();
    } catch {
      /* best effort */
    }
    await tokenStore.clear();
    await destroyDeviceKey();
    await outbox.wipe().catch(() => undefined);
    await vault.destroy().catch(() => undefined);
    await clearServerConfig();
    queryClient.clear();
    setServer(null);
    setPendingOtp(null);
    setPendingDevice(null);
    setIdentityError(null);
    setPhase('needs-server');
  }, [queryClient]);

  const value = useMemo<SessionValue>(
    () => ({
      phase,
      server,
      api,
      notice,
      identityError,
      pendingOtp,
      pendingDevice,
      suggestedServerUrl: server?.url ?? DEFAULT_SERVER_URL,
      connect,
      requestOtp,
      verifyOtp,
      bindDevice,
      requestRebind,
      signOut,
      resetPhone,
      clearNotice: () => setNotice(null),
    }),
    [phase, server, api, notice, identityError, pendingOtp, pendingDevice, connect, requestOtp, verifyOtp, bindDevice, requestRebind, signOut, resetPhone],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
