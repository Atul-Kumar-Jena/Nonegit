# Attendly — API Reference

Version 1.0 · September 2026 · Base URL: `https://attendly-api-bt9r.onrender.com`

Every request and response body is defined as a **zod schema in `packages/protocol/src`**. That code is the exact source of truth; this page is the map. Route code lives in `server/src/routes/<file>.ts` (the file is named in each section heading).

---

## 1. Conventions

- **JSON** in and out (`content-type: application/json`). IDs are UUIDs, except notifications (numeric IDs). Times are ISO-8601 UTC.
- **Reads are `GET`, every change is `POST`** (including updates and deletes such as `POST /…/:id/delete`).
- **Errors** always look like this:
  ```json
  { "error": { "code": "FORBIDDEN", "message": "Only institution admins can do this." } }
  ```
  A refused scan is `code: "REJECTED"` with `rejection: { code: "E-GEO", title, hint }`.

### 1.1 Authentication levels

| Level | What the client sends | Used by |
|---|---|---|
| **Public** | Nothing (rate-limited) | Sign-in steps, lookup, health |
| **Signed** | `Authorization: Bearer <access>` plus `x-attendly-ts`, `x-attendly-nonce`, `x-attendly-sig` (Ed25519 over `requestSigningString`), plus `x-attendly-hwsig` (chip signature, Android when attested) | Almost everything |
| **Key-signed** | `x-attendly-key` plus a device-key signature, no token | `GET /v1/notifications/poll` (background check) |
| **Staff** | Signed, and role `teacher` or `admin`. Some routes also need `requireAdmin` or a permission (`people`, `courses`, `planner`, `devices`, `broadcast`) | `/v1/staff/*` |
| **Developer** | Signed, and role `developer` (`requireRoot`). The sandbox developer is read-only on real data | `/v1/root/*` |

The signed string is built by `requestSigningString()` in `packages/protocol/src/messages.ts`:
```
TAG | METHOD | path?query | timestampMs | nonce | sha256(body) hex
```
Clock skew is allowed up to ±90 s (`CLOCK_SKEW` returns `serverTime`, and the client corrects itself). Each nonce works once (`REPLAY`).

Tokens: access tokens last 15 minutes; refresh tokens last 30 days and rotate on each use. Reusing a refresh token revokes the whole family.

### 1.2 Rate limits

- **Global:** 3000 requests/min per IP (campus Wi-Fi shares one IP).
- **Sign-in routes:** 120/min.
- **Per-device limits** on scans and the push-token route.
- `429 RATE_LIMITED` includes `retryAfterSec`.

### 1.3 Error codes (`packages/protocol/src/errors.ts`)

| Code | HTTP | Meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | Body failed validation (the message names the field) |
| `UNAUTHENTICATED`, `TOKEN_EXPIRED` | 401 | No or expired token: refresh or sign in |
| `BAD_SIGNATURE`, `CLOCK_SKEW`, `REPLAY` | 401 | Request signature problems |
| `FORBIDDEN` | 403 | Role or permission missing |
| `NOT_FOUND` | 404 | Doesn't exist **or is outside your scope** |
| `CONFLICT` | 409 | Uniqueness or state conflict (phone already bound, stale draft…) |
| `RATE_LIMITED` | 429 | Slow down |
| `OTP_INVALID`, `OTP_EXPIRED`, `OTP_LOCKED` | 400/429 | Sign-in code problems |
| `INSTITUTION_UNKNOWN`, `TICKET_INVALID`, `DEVICE_REVOKED`, `INTEGRITY`, `LIMIT_REACHED`, `ACCOUNT_SUSPENDED` | 4xx | As named |
| `REJECTED` | 422 | Scan refused. See the scan codes below |
| `INTERNAL` | 500 | Server bug (logged) |

**Scan refusal codes:**

| Code | Meaning |
|---|---|
| `E-EXPIRED` | Stale QR |
| `E-QR-INVALID` | Forged or garbled QR |
| `E-SESSION-CLOSED` | Class ended |
| `E-NOT-STARTED` | Class not started yet |
| `E-NOT-ENROLLED` | Student isn't enrolled |
| `E-GEO` | Outside the room |
| `E-GPS-WEAK` | Accuracy too low |
| `E-GPS-STALE` | Location fix too old |
| `E-MOCK` | Fake location |
| `E-DEVICE` | Not the bound phone |
| `E-INTEGRITY` | Phone failed the security check |
| `E-DUPE` | Already marked |
| `E-REVOKED` | Phone or login revoked |
| `E-PAUSED` | Scanning paused by a switch |

---

## 2. Health and meta (`meta.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | Public | `{ok:true}` when the database answers (Render health check) |
| GET | `/v1/meta` | Public | Server time, API version, minimum app version, server public key (pinned by apps to check receipts), demo accounts while demo mode is on |
| GET | `/v1/thumbs/:name` | Public | Notification thumbnail images |

## 3. Sign-in and phones (`auth.ts`, `setup.ts`, `authenticator.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/institutions/lookup?code=` | Public | Institute app: institution name for a code |
| POST | `/v1/auth/otp/request` | Public | Send a sign-in code (email, SMS or authenticator). Returns `challengeId`, masked destination, `method` (and `instantCode` for demo accounts) |
| POST | `/v1/auth/otp/verify` | Public + device proof | Check the code. Returns `ok` (tokens), `bind_required` (ticket), or `device_mismatch` (ticket, bound phone info) |
| POST | `/v1/devices/bind` | Ticket + proof | Bind this phone (optional attestation chain). Returns tokens |
| POST | `/v1/devices/rebind-request` | Ticket + proof | Ask staff to approve switching to this phone |
| GET / POST | `/v1/devices/attest` | Signed | Get an attestation challenge / upload the chip certificate chain |
| POST | `/v1/auth/refresh` | Refresh token + device sig | New access and refresh tokens (rotation) |
| POST | `/v1/auth/logout` | Signed | End this login |
| POST | `/v1/auth/setup/start` | Public | Sign-in ID plus setup code → pending Google Authenticator secret and `otpauthUrl` (5 tries per code) |
| POST | `/v1/auth/setup/finish` | Public | First 6-digit code → activates TOTP, burns the setup code, returns `instantCode` for the verify step |
| GET | `/v1/me/authenticator` | Signed | Is Google Authenticator on? |
| POST | `/v1/me/authenticator/setup` · `/confirm` · `/disable` | Signed | Link, confirm or turn off the authenticator |
| POST | `/v1/staff/people/:id/authenticator` | Staff (`people`) | Start authenticator setup for someone |
| POST | `/v1/staff/people/:id/setup-code` | Staff (`people`; admins' codes: main admin only) | Issue a new one-time setup code |
| POST | `/v1/staff/people/:id/authenticator/remove` | Staff (`people`) | Reset a lost authenticator |

## 4. Attendance (`attendance.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/attendance/mark` | Signed (student) | **The scan.** Body `MarkBody`: QR token, GPS samples, capture time, `clientRef` (offline). Returns `status: 'present'` with a server-signed receipt, `status: 'round'` (layered scans: `{done, required, current}`), or `REJECTED` + `E-*` |

## 5. Student (`student.ts`, `reports.ts`, `requests.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/me/dashboard` | Signed | Home: today's classes (`waitingForProfessor`, `lateMin`, `missed`), overall % |
| GET | `/v1/me/subjects` | Signed | Every subject with %, can-miss and must-attend |
| GET | `/v1/me/subjects/:courseId` | Signed | One subject's history |
| GET | `/v1/me/timetable` | Signed | Week timetable with change notes |
| GET | `/v1/me/profile` | Signed | Profile, phone, institution |
| POST | `/v1/me/device-reset` | Signed | Ask to unbind this phone (lost or new phone) |
| GET | `/v1/me/report` | Signed | Own attendance report (PDF/Excel data) |
| POST / GET | `/v1/me/requests` | Signed | Send an "Ask" request to a professor / list mine |
| POST | `/v1/me/requests/:id/cancel` | Signed | Cancel my request |

## 6. Notifications (`staff-planner.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/notifications` | Signed | Bell list plus unread count |
| GET | `/v1/notifications/poll?after=` | **Key-signed** | Background check for new items; read-only |
| POST | `/v1/notifications/read` | Signed | Mark some (`ids`) or `all` as read |
| POST | `/v1/me/push-token` | Signed | Register this phone's Firebase token. Returns `push: true` when the server can send |
| POST | `/v1/me/test-notification` | Signed | Sends a real test notification; returns `serverPush` and `phoneRegistered` |

## 7. Notices (`notices.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/notices` | Signed | Notices for me (filters, pinned first) |
| GET | `/v1/notices/:id` | Signed | One notice (marks it seen) |
| GET | `/v1/notices/:id/readers` | Staff (author or admin) | Seen by N of M, with names |
| POST | `/v1/notices/read-all` | Signed | Mark all read |
| POST | `/v1/notices/audience` | Staff | Preview the recipient count for an audience |
| POST | `/v1/notices` | Staff (`broadcast` for institution-wide) | Create: audience (everyone, students, faculty, admins, batches, subjects), category, important, pinned |
| POST | `/v1/notices/:id` · `/:id/delete` | Author or admin | Edit / delete (developer broadcasts are read-only) |
| POST | `/v1/notices/:id/react` | Signed | Toggle an emoji reaction |

## 8. Staff: institution and people (`staff-admin.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/staff/me` | Staff | Me: role, permissions, `owner` (main admin), mentor-of |
| GET | `/v1/staff/overview` | Staff | Today screen numbers and setup checklist |
| GET / POST | `/v1/staff/institution` | Staff / Admin | Read / update name, time zone, term, minimum % |
| GET / POST | `/v1/staff/rooms` · POST `/v1/staff/rooms/:id` | Staff / `courses` | Rooms with geofence centre and radius |
| GET | `/v1/staff/colleagues` | Staff | Other professors (for cover and substitutes) |
| GET | `/v1/staff/people` · `/v1/staff/people/:id` | Staff | Directory / one person |
| POST | `/v1/staff/people` | `people` (admins: main admin only) | Add a person (staff get a setup code) |
| POST | `/v1/staff/people/import` | `people` | Paste many students at once |
| POST | `/v1/staff/people/:id` | `people` | Edit, suspend or reactivate |
| POST | `/v1/staff/people/:id/access` | Admin (admin roles: main admin) | Role (`teacher`/`admin`) and permissions |

## 9. Staff: courses, batches, timetable (`staff-academics.ts`, `batches.ts`, `credits.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET / POST | `/v1/staff/courses` · POST `/v1/staff/courses/:id` | Staff / `courses` | List / create / edit courses |
| GET | `/v1/staff/courses/:id/roster` | Staff (own course) | Enrolled students |
| POST | `/v1/staff/courses/:id/enrollments` | `courses` | Add or remove students |
| GET | `/v1/staff/courses/:id/report` | Staff (own course) | Course attendance report |
| GET / POST | `/v1/staff/timetable` · POST `/:id` · `/:id/delete` | Staff / `courses` | Weekly slots (creating one materializes classes) |
| GET / POST | `/v1/staff/batches` · GET/POST `/:id` · POST `/:id/subjects` | Staff / `courses` | Batches, their students and subjects (auto-enrolment) |
| GET | `/v1/staff/students/search?q=` | Staff | Find students |
| GET | `/v1/staff/students/:id/missed` · `/credits` | Staff | Missed classes; credits given |
| POST | `/v1/staff/students/:id/credit` · `/v1/staff/credits/:id/undo` | Staff | Credit a missed class (medical, fest, other, with a note) / undo |

## 10. Staff: classes (`staff-sessions.ts`, `present.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/staff/sessions?date=` | Staff | Today's classes (`dueAt`, `lateMin`, `missed`, status) |
| GET | `/v1/staff/courses/:id/sessions` | Staff | A course's classes |
| POST | `/v1/staff/sessions` | Staff | Extra or one-off class |
| GET | `/v1/staff/sessions/:id` | Staff | One class, with the QR secret for its professor |
| POST | `/v1/staff/sessions/:id/start` | Professor or admin | "I'm in class": `started_at`, lateness logged, students notified |
| POST | `/v1/staff/sessions/:id/showing` | Professor | The QR is on screen ("attendance being taken") |
| POST | `/v1/staff/sessions/:id/end` · `/cancel` | Professor or admin | End (QR dies everywhere) / cancel with a reason. A class also closes itself when everyone is marked (`autoEnded`) |
| POST | `/v1/staff/sessions/:id/rounds` | Professor | Layered scans: `{rounds: 1–5}` (before anyone completes) |
| POST | `/v1/staff/sessions/:id/next-round` | Professor | Open the next scan round; students are notified |
| GET | `/v1/staff/sessions/:id/feed` | Professor | Live list of marks |
| POST | `/v1/staff/sessions/:id/register` | Professor | Paper-style register: ticks, corrections with reasons (`clientRef` for offline) |
| GET | `/v1/staff/offline-pack` | Staff | Today's and tomorrow's classes and QR secrets for offline use |
| GET | `/v1/staff/flags` · POST `/v1/staff/flags/:id` | `devices` | Suspicious scans: list / resolve |
| GET | `/v1/staff/device-requests` · POST `/:id` | `devices`, mentor or admin | Phone-switch requests: list / approve or deny |
| POST | `/v1/present/pair` · GET `/v1/present/:id` | Public (screen secret) | Big screen: get a pairing code / poll the current QR picture |
| POST | `/v1/staff/present/lookup` | Staff | Look up a pairing code shown on a screen |
| GET / POST | `/v1/staff/sessions/:id/screens` · POST `/:pairingId/disconnect` | Professor | Approve / list / disconnect big screens |
| GET | `/present`, `/tv`, `/present.js` | Public | The big-screen web page |

## 11. Staff: planner, cover, availability (`staff-planner.ts`, `requests.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/staff/planner?week=` | `planner` | The week board |
| GET / POST | `/v1/staff/drafts` · GET/POST `/:id` | `planner` | List / create / read / save a draft (`version`; stale save → 409) |
| POST | `/v1/staff/drafts/:id/check` · `/publish` · `/discard` | `planner` | Clash check / publish in one transaction / discard |
| POST | `/v1/staff/sessions/:id/adjust` | Professor (own) or `planner` | Move, substitute or cancel one class (`acceptWarnings`) |
| GET | `/v1/staff/availability?date=` | Staff | Who's busy where |
| POST | `/v1/staff/cover-requests` | Admin or `planner` | Ask a professor to cover a class, with a note |
| GET | `/v1/staff/requests` | Staff | Cover requests and student "Ask" requests to me |
| POST | `/v1/staff/requests/:id/accept` · `/decline` · `/cancel` | Staff | Respond to or withdraw a request |

## 12. Reports (`reports.ts`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/staff/students/:id/report` | Staff | One student's report |
| GET | `/v1/staff/reports/matrix` | Staff (`courses` for all) | Students × subjects matrix for PDF and Excel |
| GET | `/v1/staff/reports/punctuality?days=&teacherId=` | Staff (everyone with `courses`/`planner`, else own) | Professors' punctuality: per professor and per class |

## 13. Developer console (`root.ts`, `root-support.ts`, `root-broadcast.ts`)

All require **role `developer`**. Every change is written to the audit log under the developer's account.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/root/me` | The developer account (and whether it's the sandbox) |
| GET | `/v1/root/console` | Health, counts, production checklist, switches, recent audit |
| POST | `/v1/root/switches/:key` | Flip a kill switch. Body `{enabled, reason, confirm: "<key>"}` |
| POST | `/v1/root/sign-out-everyone` | Revoke every login (one institution or all), except developers |
| GET | `/v1/root/audit` · POST `/v1/root/audit/verify` | Read / verify the hash chain |
| GET / POST | `/v1/root/tenants` · GET `/v1/root/tenants/:id` | List / create (returns institution code and main-admin setup code) / detail |
| POST | `/v1/root/tenants/:id/status` · `/verify` · `/code` · `/admin-setup` | Suspend or activate / verify / new institution code / new main-admin setup code |
| GET / POST | `/v1/root/flags` | Per-institution flags (e.g. `hardware_binding`, `strict_geo`) |
| GET | `/v1/root/tenants/:id/people?role=&q=` | Support: an institution's people |
| GET | `/v1/root/tenants/:id/people/:pid` | Support: person detail, attendance, history |
| POST | `/v1/root/tenants/:id/people/:pid/action` | Support action `{action, as: "named" \| "support", reason}` where action ∈ `suspend`, `reactivate`, `reset_phone` (unbind and sign out), `setup_code`, `make_admin`, `make_professor`, `make_owner` |
| POST | `/v1/root/broadcast/preview` · `/v1/root/broadcast` | Recipient count / send to everyone, students or admins, in all institutions or one |
| GET | `/v1/root/broadcasts` · POST `/:id/withdraw` | Sent broadcasts with reach and reads / withdraw everywhere |

**Kill switch keys:**

| Key | Effect when on |
|---|---|
| `scans_paused` | Every scan is refused |
| `sign_ins_paused` | No new sign-ins (developers excepted) |
| `new_bindings_blocked` | Nobody can bind a phone |
| `hardware_checks_relaxed` | Chip-check failures don't refuse phones |
| `demo_login_off` | Demo accounts need a code |
| `notifications_paused` | Nothing is pushed to phones |
| `phone_rules_off` | Testing: phone binding stops no one |

## 14. Demo tools (`dev.ts`, disabled in production)

`GET /dev?token=…` shows sign-in codes when no email provider is set. `/dev/api/*` creates, starts and ends demo classes and shows their QR, for e2e tests. It is guarded by `DEV_TOOLS_TOKEN`; delete that variable in production.

---

### Example: a signed request (what `api-core.ts` does)

```ts
const body = JSON.stringify({ reason: 'lost phone' });
const ts = Date.now() + clockOffset;
const nonce = randomB64url(16);
const msg = requestSigningString({
  method: 'POST', pathWithQuery: '/v1/me/device-reset',
  timestampMs: ts, nonce, bodySha256Hex: sha256Hex(body),
});
fetch(base + '/v1/me/device-reset', {
  method: 'POST', body,
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
    'x-attendly-ts': String(ts), 'x-attendly-nonce': nonce,
    'x-attendly-sig': ed25519Sign(msg, deviceKey),
  },
});
```
