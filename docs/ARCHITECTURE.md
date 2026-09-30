# Attendly — System Architecture

Version 1.0 · September 2026

How Attendly is built: the tech stack, every folder and important file, the data model, and how the main flows travel through the code. What it must do is in [SRS.md](SRS.md); every endpoint is in [API.md](API.md).

---

## 1. The big picture

```
 ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
 │ Attendly         │  │ Attendly         │  │ Attendly         │
 │ (students)       │  │ Institute        │  │ Developer        │
 │ apps/student     │  │ apps/institute   │  │ apps/developer   │
 └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
          │ HTTPS · every request signed by the phone's own key
          │ (+ security-chip signature on Android where attested)
          ▼                     ▼                     ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ API server · server/ · Fastify 5 on Node 22 · Docker/Render  │
 │ routes/ (HTTP)  →  lib/ (rules)  →  SQL (pg)                 │
 │ background: class clock · timetable materializer · push      │
 └───────────────┬────────────────────────────────┬─────────────┘
                 │                                │
                 ▼                                ▼
 ┌───────────────────────────┐   ┌──────────────────────────────┐
 │ PostgreSQL 16 (Supabase)  │   │ Firebase Cloud Messaging     │
 │ 24 migrations, 34 tables  │   │ instant phone notifications  │
 │ audit_log = hash chain    │   │ Email: Brevo/Resend/SMTP     │
 └───────────────────────────┘   └──────────────────────────────┘

 Browser: /present (big-screen QR) · /dev (demo tools, off in production)
```

The three rules everything follows:
1. **The server is the only source of truth.** Apps cache and queue, but the server decides.
2. **Uniqueness lives in the database** (constraints and partial unique indexes), not only in code.
3. **One shared contract.** `packages/protocol` defines every request and response with zod. The server and all apps import the same schemas, so they can't drift apart.

## 2. Tech stack

| Layer | Technology | Why |
|---|---|---|
| Language | **TypeScript 6** everywhere | One language, shared types from server to phone |
| Monorepo | **npm workspaces** (`packages/*`, `server`, `apps/*`) | Shared code without publishing packages |
| Contract | **zod 4** schemas in `packages/protocol` | Runtime validation plus static types from one definition |
| Crypto | **@noble/curves**, **@noble/hashes**, **@noble/ciphers** | Audited, pure JS: Ed25519 signatures, SHA-256, HMAC, XChaCha20-Poly1305 |
| Server | **Fastify 5**, **pg 8**, @fastify/rate-limit, @fastify/cors, nodemailer, qrcode | Fast, schema-friendly HTTP; plain SQL, no ORM |
| Server build | **esbuild** → one file `dist/server.cjs` | Tiny Docker image, fast cold start |
| Database | **PostgreSQL 16** on **Supabase** | Constraints, transactions, JSONB, reliable hosting |
| Hosting | **Render** (Docker, `render.yaml` blueprint) | Deploys automatically from the branch |
| Mobile | **Expo SDK 57**, **React Native 0.86** (Hermes), **React 19**, **expo-router** | One codebase, file-based navigation, native modules via Expo |
| App data | **TanStack Query 5** plus persisted cache (AsyncStorage) | Offline-first screens, background refetch |
| App storage | **expo-secure-store** (keys) plus an encrypted vault | Keys stay in the phone's keystore |
| Native modules (ours) | `packages/hardware-key` (Android key attestation), `packages/class-alerts` (countdown alerts) | Things Expo doesn't provide |
| Phone features | expo-camera (QR), expo-location, expo-notifications, expo-background-task, expo-local-authentication, expo-screen-capture, expo-print (PDF) | |
| UI | Custom kit in `packages/app-kit` (Inter, JetBrains Mono, lucide icons, react-native-svg) | Minimal monochrome design shared by all apps |
| Push | **Firebase Cloud Messaging HTTP v1** (the server signs its own OAuth JWT) | Instant delivery when the app is closed |
| Tests | **vitest** (server integration tests on a real PostgreSQL; protocol units); **Playwright** browser rehearsals in `e2e/` | |
| CI/CD | **GitHub Actions** (`.github/workflows/ci.yml`) | Typecheck → tests → Docker smoke test → 3 APKs → emulator check → GitHub Release `build-N` |

## 3. Repository map

```
Nonegit/
├── packages/
│   ├── protocol/        the shared contract (server + all apps)
│   ├── app-kit/         shared app code: API client, session, screens, UI kit
│   ├── hardware-key/    native Android module: key in the security chip + attestation
│   └── class-alerts/    native Android module: pinned class countdown alerts
├── server/              the API (Fastify + PostgreSQL)
│   ├── migrations/      001…024 SQL files, applied in order at start-up
│   ├── src/             index → app → routes → lib
│   ├── scripts/cli.ts   migrate · seed · keys · audit:verify
│   ├── test/            32 integration test files (real database)
│   └── Dockerfile
├── apps/
│   ├── student/         Attendly
│   ├── institute/       Attendly Institute
│   └── developer/       Attendly Developer
├── e2e/                 browser rehearsals (web builds of the apps + real server)
├── docs/                this file, SRS, API, guides
├── downloads/           latest APK zips (committed by the release step)
├── render.yaml          Render blueprint
└── .github/             CI workflow, emulator smoke test
```

### 3.1 `packages/protocol/src`: the contract

| File | Holds |
|---|---|
| `schemas.ts` | Auth, device, attendance and student schemas: `OtpRequestBody`, `OtpVerifyResponse`, `BindBody`, `MarkBody`, `MarkResponse`, `TodaySession`, setup codes |
| `staff.ts` | Staff schemas: people, courses, rooms, sessions, `StaffPermission`, `Person`, `StaffSession` |
| `timetable.ts` | Slots, batches, adjustments, availability |
| `planner.ts` | Pure planner engine: `DraftOp`, `applyOps`, `findConflicts`, drag helpers |
| `root.ts` | Developer console: tenants, switches, support, broadcasts |
| `notices.ts`, `notify-kinds.ts` | Notice centre and notification kinds |
| `requests.ts`, `reports.ts` | Student requests; report shapes |
| `crypto.ts`, `encoding.ts` | Ed25519, SHA-256, HMAC, base64url helpers |
| `messages.ts` | **Exact strings that get signed** (`requestSigningString`, login proof, bind proof) |
| `qr.ts` | Rotating QR tokens `ATD1…`: `currentQrSeq`, `verifyQrMac`, `isQrSeqFresh` |
| `geo.ts` | Geofence and GPS maths: `fuseSamples`, `evaluateGeofence`, teleport and impossible-travel limits |
| `attendance.ts` | Percentage maths, "can miss N", plan-ahead |
| `errors.ts` | Every API error code and scan-refusal code with its title and hint |
| `richtext.ts` | The small formatting language used in notices |

### 3.2 `server/src`: the API

| File | Role |
|---|---|
| `index.ts` | Entry: load config → migrate → bootstrap accounts → build the app → start the push dispatcher, class clock and timetable materializer |
| `app.ts` | Builds Fastify: CORS, rate limits, security headers, gzip for JSON answers over 1 KB, 75 s keep-alive, error handler (ApiError/zod → `{error:{code,message}}`), registers every route file |
| `config.ts` | Reads every environment variable (see §8) |
| `deps.ts` | The dependency bag handed to every route: db, config, clock, hash, signer, sender, log |
| `db.ts` | pg pool, `withTx` (transaction helper), `isUniqueViolation` |
| `migrate.ts` | Applies `migrations/*.sql` once each, in order |
| `bootstrap.ts`, `seed.ts` | First institution and admin from env; the demo institution |

**`server/src/routes/`**: one file per area (full list in [API.md](API.md)).

| File | Area |
|---|---|
| `auth.ts` | Sign-in codes, verify, bind, phone switch, refresh, attestation, logout |
| `setup.ts`, `authenticator.ts` | Setup codes, Google Authenticator |
| `attendance.ts` | **The scan:** `POST /v1/attendance/mark` |
| `student.ts` | Student dashboard, subjects, timetable, phone reset |
| `staff-sessions.ts` | Classes: create, start, showing QR, end, cancel, live feed, register, offline pack, flags, phone requests |
| `staff-academics.ts` | Courses, rosters, enrolments, weekly timetable |
| `staff-admin.ts` | Institution, rooms, people, import, access and roles |
| `staff-planner.ts` | Planner drafts, publish, adjust a class, availability, notifications, push token |
| `batches.ts`, `credits.ts`, `requests.ts`, `reports.ts`, `notices.ts`, `present.ts` | As named |
| `root.ts`, `root-support.ts`, `root-broadcast.ts` | Developer console, drill-in, broadcasts |
| `meta.ts`, `dev.ts` | Health, server key, thumbnails; demo tools (disabled in production) |

**`server/src/lib/`**: the rules. Routes stay thin and call these.

| File | Rule it owns |
|---|---|
| `auth.ts` | Verifies every signed request (headers, clock skew, nonce, signature, hardware signature), issues and rotates tokens |
| `access.ts` | Who may do what: `requireAdmin`, `can(auth, permission)`, `instructorFilter` (professors see only their own) |
| `users.ts` | Loading users and devices, `assertPhoneFree` (one phone, one account), hardware hash |
| `device-trust.ts`, `attestation.ts`, `attestation-roots.ts` | Android key attestation: certificate chain up to Google's roots, security level, refusal policy |
| `audit.ts` | `appendAudit`: the SHA-256 hash chain |
| `flags.ts` | Platform kill switches (`system_flags`) and per-institution flags (`tenant_flags`) |
| `class-clock.ts` | Every 20 s: mark classes due, missed, closed; "class started" notifications |
| `timetable.ts` | Materializer: weekly slots → `class_sessions` 14 days ahead |
| `planner-server.ts` | `publishOps`: validate → apply → notify → audit, in one transaction |
| `notify.ts`, `push.ts`, `delivery.ts` | Notification rows; the FCM dispatcher (every 2 s, 500 per batch); email and SMS sign-in codes |
| `sessions.ts`, `staff-sessions.ts`, `stats.ts`, `reports.ts` | Class helpers, lecture numbers, percentages, exports |
| `cache.ts` | `ttlCache`: 30-second shared cache for heavy reports (analytics, punctuality); callers asking at once share one query |
| `receipts.ts`, `keys.ts`, `secrets.ts`, `totp.ts`, `setup-codes.ts` | Signed receipts, server key, encryption box, TOTP, setup codes |
| `guard.ts`, `metrics.ts` | Abuse guard; request stats for the console |
| `platform-access.ts` | Main-admin backfill; the developer account and its first-time setup code |
| `batches.ts`, `mentors.ts`, `requests.ts`, `demo.ts` | Batch enrolment sync, mentor routing, requests, demo rules |

### 3.3 `packages/app-kit/src`: shared by all three apps

| Folder / file | What |
|---|---|
| `lib/api-core.ts` | **The signed HTTP client.** `authed()` = bearer token plus device signature (plus chip signature). `keySigned()` = device key only (background checks). Handles token refresh and clock offset |
| `lib/device-key.ts`, `lib/hardware.ts` | The phone's Ed25519 key; the chip key via `packages/hardware-key` |
| `lib/vault.ts`, `lib/storage.ts`, `lib/tokens.ts` | Encrypted on-phone storage; tokens |
| `lib/outbox.ts` | Offline queue with idempotent `clientRef`s |
| `lib/notifications.ts` | Bell, phone notifications, 15-minute background check, Firebase token registration |
| `lib/location.ts` | Multi-sample GPS for scans |
| `lib/permissions.ts`, `battery.ts`, `reminders.ts`, `screenshots.ts`, `biometrics.ts` | Phone permissions and settings |
| `state/session.tsx` | Session phases (server → institution → login → verify → bind → signed in), `useApi`, `useSession` |
| `screens/` | Shared screens: Login, Verify, Bind, Setup, Mismatch, Notifications, Notices, Permissions, Security, Reminders, Server, Institution |
| `components/` | UI kit (`ui.tsx`: Button, Card, Input, Text…), `Screen` (padding and keyboard), `AppLock`, `QrCode`, `RichText`, `SetupCodeCard`, `SyncBanner` |
| `theme.ts` | Colours, spacing, radius |

### 3.4 The apps (expo-router: the file path is the screen path)

**`apps/student/app`**
- `(auth)/`: server, login, verify, setup, bind, mismatch
- `(app)/(tabs)/`: home, timetable, subjects, profile
- `(app)/`: scan, result, subject/[id], notices, notice/[id], notifications, requests, report, reminders, permissions, security
- `src/components/QrScanner.tsx`: whole-frame QR detection, zoom, torch

**`apps/institute/app`**
- `(auth)/`: institution-code, login, verify, setup, bind, mismatch
- `(app)/(tabs)/`: home (Today), timetable, classes, more
- Classes: session/[id], live/[id], register/[id], attend, extra-class
- Academics: course/[id], course-form, slot-form, roster, batches, batch/[id], rooms
- People: people/index, people/[id], person-form, import, student/[id]
- Planning: planner, busy, cover
- Other: notices, notice-compose, notice/[id], notifications, inbox, requests, reports, flags, institution, setup, security, reminders, permissions
- `src/planner/`: drag-and-drop board engine; `src/components/`: AppLock, BigScreen, Adjust

**`apps/developer/app`**
- `(tabs)/`: home (console, switches, sign everyone out), tenants, audit, flags, profile
- new-tenant, tenant/[id], tenant/people, tenant/person (support actions), broadcast
- `src/api.ts`: typed calls to `/v1/root/*`

## 4. Data model (PostgreSQL)

34 tables, created by `server/migrations/001…024`. Grouped by purpose:

| Group | Tables | Notes |
|---|---|---|
| Institutions | `tenants`, `tenant_flags` | `tenants.code` (institution code), `verified_at`, `sandbox` |
| People and access | `users`, `devices`, `push_tokens`, `device_online` | `users.role` ∈ student/teacher/admin/developer; `is_owner` (one per tenant, unique partial index); `permissions[]`; TOTP secret encrypted; setup-code hash. One active device per user, one user per key |
| Sign-in | `otp_challenges`, `auth_tickets`, `auth_sessions`, `request_nonces`, `attest_challenges` | Codes and tokens stored as hashes; refresh families; nonce replay guard |
| Academics | `courses`, `enrollments`, `rooms`, `batches`, `batch_members`, `course_batches` | Unique (tenant, code), (tenant, roll no.), (tenant, room name) |
| Timetable | `timetable_slots`, `class_sessions`, `timetable_drafts`, `change_requests` | `class_sessions` unique (slot, date); `due_at`, `started_at`, `missed_at`, `change_kind`, `substitute_id` |
| Attendance | `attendance_records`, `scan_rejections`, `attendance_credits`, `client_actions` | Unique (session, student); `client_actions` makes offline uploads idempotent |
| Phones | `device_requests` | One pending request per person |
| Communication | `notifications`, `notices`, `notice_reads`, `notice_reactions` | `notifications.pushed_at` drives the FCM dispatcher; `notices.platform` / `broadcast_id` for developer broadcasts |
| Big screen | `present_pairings` | Pairing code as an HMAC, screen secret as sha256 |
| Platform | `system_flags`, `audit_log` | Kill switches; the append-only hash chain (updates and deletes refused by trigger) |

## 5. How a request travels

1. **The app** (`api-core.ts`) builds the body, hashes it, and signs
   `requestSigningString(method, path?query, timestampMs, nonce, bodySha256)` with the phone's Ed25519 key. It sends:
   - `Authorization: Bearer <access token>`
   - `x-attendly-ts`, `x-attendly-nonce`, `x-attendly-sig`
   - `x-attendly-hwsig` (chip signature, Android, when attested)
2. **Fastify** applies the per-IP rate limit, then the route.
3. **`requireDevice`** (`lib/auth.ts`):
   - checks the token and the device is active;
   - checks the clock (±90 s) and stores the nonce once;
   - verifies the signature against the bound key.
   - It returns an `AuthContext` (user, role, tenant, device, permissions).
4. **The route** parses the body with the protocol's zod schema and calls `lib/` rules inside `withTx` (one transaction).
5. Every change calls **`appendAudit`**.
6. Errors become `{ "error": { "code", "message" } }` with the right HTTP status.

## 6. Key flows

### 6.1 Sign-in and binding
- `POST /v1/auth/otp/request` → the code is sent (email, SMS or authenticator).
- `POST /v1/auth/otp/verify` with a proof signed by the new phone key. Result:
  - `bind_required` (first phone) → `POST /v1/devices/bind` with the ticket, proof and optional attestation chain → tokens;
  - `ok` (same phone, or a developer);
  - `device_mismatch` → `POST /v1/devices/rebind-request` → staff approve in `staff-sessions.ts`.
- Code: `routes/auth.ts`, `lib/users.ts` (`assertPhoneFree`), `lib/device-trust.ts`.

### 6.2 Setup codes and the authenticator
- `setup/start` checks the code (5 tries) and returns a pending TOTP secret.
- `setup/finish` verifies the first 6-digit code, activates TOTP, burns the setup code, and returns an `instantCode`. The app then uses the normal verify and bind flow.
- Code: `routes/setup.ts`, `lib/setup-codes.ts`, `lib/totp.ts`.

### 6.3 A class
1. `lib/timetable.ts` materializes slots into `class_sessions`.
2. `lib/class-clock.ts` sets `due_at` (students see "Waiting for the professor").
3. The professor taps **start** (`POST /v1/staff/sessions/:id/start`): `started_at` is set, lateness is logged, students are notified.
4. The professor shows the QR (`/showing`): the phone renders `ATD1…` tokens from the class secret and sequence (`protocol/qr.ts`).
5. The student scans (`routes/attendance.ts`). Checks run in this order:
   1. MAC and freshness;
   2. class live;
   3. enrolled;
   4. bound device and chip;
   5. GPS: fused samples, accuracy ≤ 75 m, age ≤ 60 s, no mock, no teleport or impossible travel, inside the geofence.
6. The record is inserted (unique per student and class), a receipt is signed (`lib/receipts.ts`), and the audit entry is written.
7. End (`/end`) closes the QR everywhere, including the big screen.

### 6.4 Offline
- **Student:** the scan is sealed with its capture time and queued in `outbox.ts`, then uploaded later. The server judges it against capture time, up to 24 h.
- **Professor:** `GET /v1/staff/offline-pack` downloads today's and tomorrow's classes and QR secrets.
- Every queued action has a `clientRef`. `client_actions` makes a replay a no-op.

### 6.5 Planner
- The draft is saved with a version, and a stale version returns 409.
- `POST /drafts/:id/check` lists clashes; `/publish` runs `publishOps` in one transaction.
- `lib/notify.ts` writes one grouped notification per affected person.

### 6.6 Notifications
1. Any change inserts rows into `notifications`.
2. `lib/push.ts` polls every 2 s for rows where `pushed_at is null`, and sends each to the person's `push_tokens` through FCM HTTP v1 (high priority, channel `timetable-alerts`).
3. Dead tokens are deleted.
4. Each app is sent through its own Firebase project (`FCM_SERVICE_ACCOUNT_STUDENT` for students, `FCM_SERVICE_ACCOUNT_INSTITUTE` for professors and admins; `FCM_SERVICE_ACCOUNT` is the shared fallback). Without one, that app's phones rely on the in-app refresh and the 15-minute background check (`GET /v1/notifications/poll`, key-signed).

### 6.7 Developer console
- `routes/root.ts` handles switches (upserted into `system_flags`), tenants, the audit log and "sign everyone out".
- `root-support.ts` handles actions on people. It always writes `support.*` and `root.support` audit entries under the developer's user ID. Only the shown name changes.

## 7. Security architecture (summary)

| Threat | Defence | Where |
|---|---|---|
| Stolen token | Every request also needs the phone's signature | `lib/auth.ts` |
| Replay | Timestamp ±90 s plus single-use nonce | `request_nonces` |
| Proxy attendance (friend scans) | Bound phone, GPS geofence, rotating QR | `routes/attendance.ts` |
| Photo of QR sent away | QR goes stale in seconds; location check | `protocol/qr.ts`, `geo.ts` |
| Fake GPS | Mock flag, accuracy, multi-sample fusion, teleport and impossible-travel checks | `protocol/geo.ts` |
| Cloned or rooted phone | Android key attestation, chip-signed requests | `lib/attestation.ts`, `packages/hardware-key` |
| Code guessing | 5 tries per code, 10 failures per day, alerts, rate limits | `routes/auth.ts` |
| Insider edits history | Hash-chained, append-only audit log | `lib/audit.ts`, DB trigger |
| Cross-institution leak | Tenant scoping on every query; 404 outside scope | `lib/access.ts` |
| Secrets in the repo | All secrets only in Render env or GitHub secrets | `render.yaml`, `config.ts` |

## 7b. Data lifecycle (what is kept, what is trimmed)

**Kept for good** (the institution's records): users, batches, courses, timetable slots, every class
(held, missed, cancelled), attendance records and credits, devices, and the tamper-evident audit log.

**Trimmed** by `server/src/lib/retention.ts`, run by the janitor about once an hour:

| Data | Kept |
|---|---|
| Replay nonces, phone-chip challenges | until they expire |
| Sign-in codes, binding tickets, expired logins | 1 day |
| Replaced login tokens (every 15-min refresh leaves one) | 7 days |
| Signed-out logins | 30 days |
| Online-evidence minutes (offline-scan checks) | 2 days |
| Big-screen pairings | 7 days after they end |
| Offline-upload receipts (idempotency) | 30 days |
| Push addresses | until the phone signs out, or 120 days without refresh |
| Notifications | read: 6 months · unread: 1 year |
| Reviewed scan refusals | 1 year (open ones until reviewed) |
| Per-round scans of multi-scan classes | 120 days (the chain head stays on the attendance record) |
| Answered class requests · decided phone requests | 6 months · 1 year |
| Deleted notices · finished planner drafts | 30 days · 90 days |

How it runs: one server at a time (Postgres advisory lock), 5,000 rows per batch with a pause between
batches, every rule served by an index (`027_lifecycle_indexes.sql`). The Developer console → **Data &
storage** shows the database size, the biggest tables and what the last run removed. In production only
slow (> 1.5 s) or failed requests are logged.

## 8. Configuration (Render → Environment)

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `DATABASE_SSL`, `DATABASE_SSL_CA`, `DATABASE_POOL_MAX` | Supabase connection |
| `SERVER_SIGNING_KEY`, `TOKEN_PEPPER` | Receipt signing key; pepper for hashes and encryption. **Secret** |
| `PUBLIC_URL`, `CORS_ORIGINS`, `TRUST_PROXY`, `HOST`, `PORT` | Networking |
| `OTP_DELIVERY` (console/smtp/brevo/resend), `EMAIL_API_KEY`, `SMTP_URL`, `SMTP_FROM` | Sign-in email |
| `SMS_DELIVERY`, `TWILIO_*` | Optional SMS codes |
| `FCM_SERVICE_ACCOUNT_STUDENT`, `FCM_SERVICE_ACCOUNT_INSTITUTE` | Each app's Firebase service-account JSON (the whole file) for instant push; `FCM_SERVICE_ACCOUNT` = one for both. **Secret** |
| `BOOTSTRAP_*` | First institution, admin, demo accounts, developer email |
| `DEVELOPER_SIGN_IN_ID`, `DEVELOPER_AUTHENTICATOR_RESET` | Developer account |
| `DEMO_INSTANT_LOGIN`, `SEED_DEMO`, `DEV_TOOLS_TOKEN` | Demo mode (turn off in production) |
| `HARDWARE_BINDING_DEFAULT`, `REQUIRE_HARDWARE_KEYS`, `ALLOW_EMULATORS`, `ALLOW_WEB_CLIENTS`, `ANDROID_APP_CERT_SHA256`, `MIN_APP_VERSION` | Phone trust policy |

GitHub secrets (CI): `GOOGLE_SERVICES_JSON_STUDENT` and `GOOGLE_SERVICES_JSON_INSTITUTE` (each app's Firebase config; `GOOGLE_SERVICES_JSON` = one for both; CI checks the file lists the app's package name) and the release-signing keystore secrets.

## 9. Build, test and deploy

| Step | Command / place |
|---|---|
| Install | `npm ci` at the repo root |
| Server locally | `cd server && cp .env.example .env` (set `DATABASE_URL`), then `npm run dev` |
| App locally | `cd apps/student && npx expo start` (Android device, emulator or web) |
| Typecheck everything | `npm run typecheck` |
| Server tests | `cd server && npm test` (needs PostgreSQL; `DATABASE_URL` or local 5432) |
| Browser rehearsals | `e2e/*.cjs` against web builds |
| CI on every push | typecheck → protocol and server tests → JS bundles → Docker smoke → 3 release APKs (arm64, armv7, x86_64) → **emulator opens every app** → GitHub Release `build-N` |
| Deploy the server | Render auto-deploys the branch (`render.yaml`); migrations run on start |
| APKs | `https://github.com/atul-kumar-jena/nonegit/releases/download/build-N/attendly-<app>.apk` |

## 10. Where to change what

| I want to… | Edit |
|---|---|
| Add or change an API field | `packages/protocol/src/*.ts` first, then the route, then the app screen |
| Add an endpoint | A file in `server/src/routes/` (registered in `app.ts`), rules in `lib/`, a test in `server/test/` |
| Change the database | A **new** `server/migrations/0NN_name.sql`. Never edit an old migration |
| Add a screen | A new file under `apps/<app>/app/(app)/…`; shared screens go in `packages/app-kit/src/screens` |
| Change colours or spacing | `packages/app-kit/src/theme.ts`, `components/ui.tsx` |
| Add a kill switch | `SWITCHES` in `server/src/lib/flags.ts`, plus a migration inserting its `system_flags` row |
| Change scan rules | `server/src/routes/attendance.ts`, `packages/protocol/src/geo.ts` / `qr.ts` |
