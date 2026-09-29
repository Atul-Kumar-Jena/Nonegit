/**
 * Platform-agnostic Attendly API client (no React Native imports, so it is
 * unit-tested in Node against the real server).
 *
 * Security properties:
 *  • Every authenticated request is signed with the device's Ed25519 key
 *    (method, path, timestamp, nonce, SHA-256 of the exact body), so a stolen
 *    bearer token is useless without the phone.
 *  • Every response is validated against the shared zod contract.
 *  • Tokens refresh automatically (single-flight) and clock drift against the
 *    server is measured and corrected transparently.
 */
import { z } from 'zod';
import { parseServerAddress } from './server-address';
import {
  API_ERROR_CODES,
  AttestStatusResponse,
  AuthTokens,
  BindResponse,
  attestBindChallengeString,
  fromB64url,
  sha256Bytes,
  DashboardResponse,
  DeviceRequestResponse,
  MarkResponse,
  MetaResponse,
  OtpRequestResponse,
  OtpVerifyResponse,
  ProfileResponse,
  SubjectsResponse,
  NoticesResponse,
  NoticeDetail,
  NoticeReaders,
  AudienceCountResponse,
  type NoticeAudience,
  type NoticeBody,
  type NoticeUpdateBody,
  InstitutionLookup,
  StudentReport,
  bindProofString,
  isRejectionCode,
  loginProofString,
  randomToken,
  receiptSigningString,
  requestSigningString,
  sha256Hex,
  signB64,
  toB64url,
  verifyB64,
  type ApiErrorCode,
  type DeviceInfo,
  type MarkBody,
  type MarkResponse as MarkResponseT,
  type OtpRequestBody,
  type RejectionCode,
  SetupStartResponse,
  type SetupStartBody,
  type SetupFinishBody,
} from '@attendly/protocol';

export interface DeviceKeyProvider {
  /** Returns the device's Ed25519 secret key (created on first use). */
  secretKey(): Promise<Uint8Array>;
  publicKey(): Promise<Uint8Array>;
}

/**
 * The phone's security chip (Android TEE / StrongBox). Its key can't be copied off the phone; the server
 * verifies Google's attestation of it at binding, and every scan must then carry its signature.
 */
export interface HardwareSigner {
  /** Makes a fresh chip key bound to this challenge and returns its attestation chain; null when unsupported. */
  attest(challenge: Uint8Array): Promise<string[] | null>;
  /** Signs with the chip key; null when this phone has none. */
  sign(data: string): Promise<string | null>;
}

export interface TokenStore {
  get(): Promise<AuthTokens | null>;
  set(tokens: AuthTokens): Promise<void>;
  clear(): Promise<void>;
}

export interface Rejection {
  code: RejectionCode;
  title: string;
  hint: string;
  detail?: string;
}

export class ApiRequestError extends Error {
  constructor(
    /** UNREADABLE = not JSON at all (e.g. a web page); BAD_RESPONSE = JSON that breaks the API contract. */
    readonly code: ApiErrorCode | 'NETWORK' | 'TIMEOUT' | 'BAD_RESPONSE' | 'UNREADABLE',
    message: string,
    readonly status = 0,
    readonly rejection?: Rejection,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** True when retrying later might succeed (connectivity / server hiccup). */
  get transient(): boolean {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT' || this.status >= 500;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  keys: DeviceKeyProvider;
  tokens: TokenStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Called when the session can no longer be recovered (refresh failed). */
  onSessionLost?: (reason: ApiRequestError) => void;
  /** Called whenever the server clock offset is re-measured (persist it for offline use). */
  onClockSync?: (offsetMs: number) => void;
  now?: () => number;
  /** The security chip, when this phone has one (Android). */
  hardware?: HardwareSigner;
}

/** Requests the security chip signs as well (scans: proof they came from the bound phone itself). */
const CHIP_SIGNED_PATHS: readonly string[] = ['/v1/attendance/mark'];

const SESSION_FATAL: readonly string[] = ['UNAUTHENTICATED', 'DEVICE_REVOKED', 'ACCOUNT_SUSPENDED'];

/** Canonical, validated base URL (see server-address.ts for why this avoids `URL`). */
export function normalizeBaseUrl(raw: string, allowHttp: boolean): string {
  return parseServerAddress(raw, allowHttp);
}

const OkLike = z.object({ ok: z.literal(true) });

export class ApiClient {
  readonly baseUrl: string;
  private readonly keys: DeviceKeyProvider;
  private readonly tokens: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly onSessionLost?: (reason: ApiRequestError) => void;
  private readonly onClockSync?: (offsetMs: number) => void;
  private readonly now: () => number;
  private readonly hardware?: HardwareSigner;
  private refreshing: Promise<AuthTokens> | null = null;
  /** serverTime − localTime, measured from the x-server-time header. */
  private offsetMs = 0;
  private offsetKnown = false;

  constructor(o: ApiClientOptions) {
    // Defence in depth: nothing unvalidated may ever reach the native network stack.
    // (A base URL is canonical iff re-parsing it is a no-op; http is re-checked by the caller's policy.)
    if (parseServerAddress(o.baseUrl, true) !== o.baseUrl) throw new Error('ApiClient: base URL must be normalised with normalizeBaseUrl()');
    this.baseUrl = o.baseUrl;
    this.keys = o.keys;
    this.tokens = o.tokens;
    this.fetchImpl = o.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.onSessionLost = o.onSessionLost;
    this.onClockSync = o.onClockSync;
    this.now = o.now ?? Date.now;
    this.hardware = o.hardware;
  }

  /** Current time on the server's clock (best estimate), in whole milliseconds. */
  serverNow(): number {
    return Math.round(this.now() + this.offsetMs);
  }

  /** Seed the offset from a previous run so offline timestamps are server-aligned from the start. */
  setClockOffset(offsetMs: number): void {
    if (!this.offsetKnown && Number.isFinite(offsetMs)) this.offsetMs = offsetMs;
  }

  /** Measured device-vs-server clock drift in ms (null until first response). */
  clockDriftMs(): number | null {
    return this.offsetKnown ? -this.offsetMs : null;
  }

  // ───────────────────────────── transport ─────────────────────────────

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    headers: Record<string, string>,
    timeoutMs = this.timeoutMs,
  ): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    const sentAt = this.now();
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw new ApiRequestError('TIMEOUT', 'The server took too long to respond. Check your connection and try again.');
      throw new ApiRequestError('NETWORK', 'Can’t reach the Attendly server. Check your internet connection.');
    } finally {
      clearTimeout(timer);
    }
    const serverTime = Number(res.headers.get('x-server-time'));
    if (Number.isFinite(serverTime) && serverTime > 0) {
      const rtt = this.now() - sentAt;
      this.offsetMs = serverTime - (sentAt + rtt / 2);
      this.offsetKnown = true;
      this.onClockSync?.(this.offsetMs);
    }
    let json: unknown = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiRequestError('UNREADABLE', 'The server sent an unreadable response.', res.status);
      }
    }
    return { status: res.status, json };
  }

  private toError(status: number, json: unknown): ApiRequestError {
    const e = (json as { error?: { code?: unknown; message?: unknown; rejection?: unknown; retryAfterSec?: unknown } } | null)?.error;
    const code = typeof e?.code === 'string' && e.code in API_ERROR_CODES ? (e.code as ApiErrorCode) : status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
    const message = typeof e?.message === 'string' && e.message.length < 300 ? e.message : API_ERROR_CODES[code];
    let rejection: Rejection | undefined;
    const r = e?.rejection as Partial<Rejection> | undefined;
    if (r && isRejectionCode(r.code) && typeof r.title === 'string' && typeof r.hint === 'string')
      rejection = { code: r.code, title: r.title, hint: r.hint, ...(typeof r.detail === 'string' ? { detail: r.detail } : {}) };
    const retry = typeof e?.retryAfterSec === 'number' ? e.retryAfterSec : undefined;
    return new ApiRequestError(code, message, status, rejection, retry);
  }

  private parse<T>(schema: z.ZodType<T>, json: unknown, status: number): T {
    const r = schema.safeParse(json);
    if (!r.success) throw new ApiRequestError('BAD_RESPONSE', 'The server sent a response this app does not understand. Update the app or contact support.', status);
    return r.data;
  }

  private async publicCall<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, payload?: unknown, timeoutMs?: number): Promise<T> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const { status, json } = await this.send(method, path, body, {}, timeoutMs);
    if (status < 200 || status >= 300) throw this.toError(status, json);
    return this.parse(schema, json, status);
  }

  private async signedHeaders(method: string, path: string, body: string): Promise<Record<string, string>> {
    const ts = this.serverNow();
    const nonce = randomToken(16);
    const signing = requestSigningString({ method, pathWithQuery: path, timestampMs: ts, nonce, bodySha256Hex: sha256Hex(body) });
    const sig = signB64(signing, await this.keys.secretKey());
    const headers: Record<string, string> = { 'x-attendly-ts': String(ts), 'x-attendly-nonce': nonce, 'x-attendly-sig': sig };
    if (this.hardware && CHIP_SIGNED_PATHS.includes(path)) {
      // No chip key yet (older binding) → the server decides whether that's still allowed.
      const hw = await this.hardware.sign(signing).catch(() => null);
      if (hw) headers['x-attendly-hwsig'] = hw;
    }
    return headers;
  }

  /** The chip's attestation for a bind ticket (null: no chip, or it failed — the server decides). */
  private async attestTicket(ticket: string): Promise<{ chain: string[] } | undefined> {
    if (!this.hardware) return undefined;
    try {
      const chain = await this.hardware.attest(sha256Bytes(attestBindChallengeString(ticket)));
      return chain ? { chain } : undefined;
    } catch {
      return undefined;
    }
  }

  private async refreshTokens(): Promise<AuthTokens> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const current = await this.tokens.get();
        if (!current) throw new ApiRequestError('UNAUTHENTICATED', API_ERROR_CODES.UNAUTHENTICATED, 401);
        const path = '/v1/auth/refresh';
        const body = JSON.stringify({ refreshToken: current.refreshToken });
        let result = await this.send('POST', path, body, await this.signedHeaders('POST', path, body));
        if (result.status === 401 && (result.json as { error?: { code?: string } })?.error?.code === 'CLOCK_SKEW')
          result = await this.send('POST', path, body, await this.signedHeaders('POST', path, body));
        if (result.status !== 200) {
          const err = this.toError(result.status, result.json);
          // Only a definitive "this session is dead" ends it. Rate limits, outages and
          // network trouble keep the (still valid) refresh token for the next attempt.
          if (SESSION_FATAL.includes(err.code)) {
            await this.tokens.clear();
            this.onSessionLost?.(err);
          }
          throw err;
        }
        const tokens = this.parse(AuthTokens, result.json, result.status);
        await this.tokens.set(tokens);
        return tokens;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Signed, authenticated request with transparent refresh and clock-skew recovery. */
  async authed<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, payload?: unknown): Promise<T> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    for (let attempt = 0; attempt < 3; attempt++) {
      let tokens = await this.tokens.get();
      if (!tokens) throw new ApiRequestError('UNAUTHENTICATED', API_ERROR_CODES.UNAUTHENTICATED, 401);
      if (Date.parse(tokens.accessExpiresAt) - this.serverNow() < 20_000) tokens = await this.refreshTokens();
      const headers = { authorization: `Bearer ${tokens.accessToken}`, ...(await this.signedHeaders(method, path, body)) };
      const { status, json } = await this.send(method, path, payload === undefined ? undefined : body, headers);
      if (status >= 200 && status < 300) return this.parse(schema, json, status);
      const err = this.toError(status, json);
      if (attempt < 2 && err.code === 'TOKEN_EXPIRED') {
        await this.refreshTokens();
        continue;
      }
      if (attempt < 2 && err.code === 'CLOCK_SKEW') continue; // offset was just re-measured from this response
      if (SESSION_FATAL.includes(err.code)) {
        await this.tokens.clear();
        this.onSessionLost?.(err);
      }
      throw err;
    }
    throw new ApiRequestError('INTERNAL', API_ERROR_CODES.INTERNAL);
  }

  /**
   * Signed by the device key alone (no login token): used only for the read-only
   * background notification check, so it can never race the app's token refresh.
   */
  async keySigned<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const headers = { 'x-attendly-key': toB64url(await this.keys.publicKey()), ...(await this.signedHeaders('GET', path, '')) };
    const { status, json } = await this.send('GET', path, undefined, headers);
    if (status < 200 || status >= 300) throw this.toError(status, json);
    return this.parse(schema, json, status);
  }

  // ───────────────────────────── endpoints ─────────────────────────────

  /** `timeoutMs` lets the first connect wait for a sleeping free-tier server to wake up. */
  meta(timeoutMs?: number) {
    return this.publicCall('GET', '/v1/meta', MetaResponse, undefined, timeoutMs);
  }

  /** Institute app: the institution behind a code (name + verified). */
  lookupInstitution(code: string) {
    return this.publicCall('GET', `/v1/institutions/lookup?code=${encodeURIComponent(code)}`, InstitutionLookup);
  }

  requestOtp(body: OtpRequestBody) {
    return this.publicCall('POST', '/v1/auth/otp/request', OtpRequestResponse, body);
  }

  /** First sign-in with a setup code: a Google Authenticator key to add. */
  setupStart(body: SetupStartBody) {
    return this.publicCall('POST', '/v1/auth/setup/start', SetupStartResponse, body);
  }

  /** The first authenticator code: links it and hands back a one-time sign-in code for this phone. */
  setupFinish(body: SetupFinishBody) {
    return this.publicCall('POST', '/v1/auth/setup/finish', OtpRequestResponse, body);
  }

  async verifyOtp(challengeId: string, code: string, device: Omit<DeviceInfo, 'publicKey'>) {
    const publicKeyB64 = toB64url(await this.keys.publicKey());
    const proof = signB64(loginProofString({ challengeId, publicKeyB64 }), await this.keys.secretKey());
    const res = await this.publicCall('POST', '/v1/auth/otp/verify', OtpVerifyResponse, { challengeId, code, device: { ...device, publicKey: publicKeyB64 }, proof });
    if (res.status === 'ok') await this.tokens.set(res.auth);
    return res;
  }

  async bind(ticket: string) {
    const publicKeyB64 = toB64url(await this.keys.publicKey());
    const proof = signB64(bindProofString({ ticket, publicKeyB64, purpose: 'bind' }), await this.keys.secretKey());
    const attestation = await this.attestTicket(ticket);
    const res = await this.publicCall('POST', '/v1/devices/bind', BindResponse, { ticket, proof, ...(attestation ? { attestation } : {}) });
    await this.tokens.set(res.auth);
    return res;
  }

  async requestRebind(ticket: string, reason: string) {
    const publicKeyB64 = toB64url(await this.keys.publicKey());
    const proof = signB64(bindProofString({ ticket, publicKeyB64, purpose: 'rebind' }), await this.keys.secretKey());
    const attestation = await this.attestTicket(ticket);
    return this.publicCall('POST', '/v1/devices/rebind-request', DeviceRequestResponse, { ticket, proof, reason, ...(attestation ? { attestation } : {}) });
  }

  /**
   * Phones bound before chip keys: moves the key into the security chip (once; silent).
   * Returns where the key lives now.
   */
  async secureWithChip(): Promise<'none' | 'tee' | 'strongbox'> {
    const st = await this.authed('GET', '/v1/devices/attest', AttestStatusResponse);
    if (st.hardware !== 'none' || !st.challenge || !this.hardware) return st.hardware;
    const chain = await this.hardware.attest(fromB64url(st.challenge));
    if (!chain) return 'none';
    const r = await this.authed('POST', '/v1/devices/attest', z.object({ hardware: z.enum(['tee', 'strongbox']) }), { chain });
    return r.hardware;
  }

  dashboard() {
    return this.authed('GET', '/v1/me/dashboard', DashboardResponse);
  }

  subjects() {
    return this.authed('GET', '/v1/me/subjects', SubjectsResponse);
  }

  // ── notice centre (everyone) ──
  notices(q: { filter?: 'all' | 'unread' | 'pinned' | 'mine'; category?: string; before?: string } = {}) {
    const qs = Object.entries(q)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return this.authed('GET', `/v1/notices${qs ? `?${qs}` : ''}`, NoticesResponse);
  }
  notice(id: string) {
    return this.authed('GET', `/v1/notices/${encodeURIComponent(id)}`, NoticeDetail);
  }
  /** Author / admin: who has opened a notice, and who hasn't yet. */
  noticeReaders(id: string) {
    return this.authed('GET', `/v1/notices/${encodeURIComponent(id)}/readers`, NoticeReaders);
  }
  reactToNotice(id: string, emoji: string) {
    return this.authed('POST', `/v1/notices/${encodeURIComponent(id)}/react`, NoticeDetail.shape.reactions, { emoji });
  }
  readAllNotices() {
    return this.authed('POST', '/v1/notices/read-all', OkLike, {});
  }
  // ── notices (staff) ──
  noticeAudience(a: NoticeAudience) {
    return this.authed('POST', '/v1/notices/audience', AudienceCountResponse, a);
  }
  sendNotice(b: NoticeBody) {
    return this.authed('POST', '/v1/notices', NoticeDetail, b);
  }
  editNotice(id: string, b: NoticeUpdateBody) {
    return this.authed('POST', `/v1/notices/${encodeURIComponent(id)}`, NoticeDetail, b);
  }
  deleteNotice(id: string) {
    return this.authed('POST', `/v1/notices/${encodeURIComponent(id)}/delete`, OkLike, {});
  }

  /** Own attendance report (all subjects, or one with its class-by-class log). */
  report(courseId?: string) {
    return this.authed('GET', `/v1/me/report${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ''}`, StudentReport);
  }

  profile() {
    return this.authed('GET', '/v1/me/profile', ProfileResponse);
  }

  requestDeviceReset(reason: string) {
    return this.authed('POST', '/v1/me/device-reset', DeviceRequestResponse, { reason });
  }

  mark(body: MarkBody) {
    return this.authed('POST', '/v1/attendance/mark', MarkResponse, body);
  }

  async logout() {
    try {
      await this.authed('POST', '/v1/auth/logout', ApiOk, {});
    } finally {
      await this.tokens.clear();
    }
  }
}

const ApiOk = z.object({ ok: z.literal(true) });

/**
 * Verifies the server's Ed25519 signature on an attendance receipt against the
 * pinned server key. A failure means the response did not come from the real
 * Attendly server (or was altered in transit).
 */
export function verifyReceipt(res: Extract<MarkResponseT, { status: 'present' }>, pinned: { kid: string; publicKey: Uint8Array }): boolean {
  if (res.receipt.serverKeyId !== pinned.kid) return false;
  const message = receiptSigningString({
    recordId: res.record.id,
    sessionId: res.record.sessionId,
    userId: res.receipt.userId,
    markedAt: res.record.markedAt,
    deviceFingerprint: res.receipt.deviceFingerprint,
    qrSeq: res.record.qrSeq,
    serverKeyId: res.receipt.serverKeyId,
  });
  return verifyB64(res.receipt.signature, message, pinned.publicKey);
}
