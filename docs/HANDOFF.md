# Handoff: everything needed to continue Attendly

Written so a new person, or a new AI chat, can pick up the work with no other context. Read this file, then `README.md` and `docs/HOW-IT-WORKS.md`.

## 0. Starting a new chat

Paste this as the first message of the new chat (with the repository attached):

> Continue the Attendly project in `atul-kumar-jena/nonegit`, branch `claude/three-secure-synced-apps-42sdud`. Read `docs/HANDOFF.md` first; it has the architecture, the rules and the next steps. Work only on that branch, run the checks in §5 before every push, and keep the handoff up to date.

## 1. What exists today

| Part | Folder | Status |
|---|---|---|
| **Attendly Institute** (admins + teachers) | `apps/institute` | Done. Onboarding checklist, rooms, people (paste import), courses, batches, weekly timetable, QR and register classes, big-screen pairing, live feed, corrections, reports + CSV, device-reset approvals, suspicious scans, **drag-and-drop planner** (drafts → review → publish), **adjust a class** (move / substitute / cancel), **who's busy**, notifications, permissions, app lock + screenshot block |
| **Attendly** (students) | `apps/student` | Done. Telegram-style QR scanner, signed receipts, subjects with % and "can miss N", plan-ahead calculator, history, timetable with change notes, notifications (in-app + phone, default sound), permissions, offline scans, device-reset request |
| **Server** | `server` | Done. Fastify 5 + PostgreSQL 16, 4 migrations, deploys to Render with Supabase |
| Shared contract | `packages/protocol` | zod schemas, crypto, QR tokens, attendance maths, planner engine |
| Shared app code | `packages/app-kit` | signed API client, vault, outbox, sign-in screens, notifications, permissions, UI kit |
| Browser rehearsal | `e2e/` | 29 steps, both apps, online + offline, QR decoded from pixels |
| CI | `.github/workflows/ci.yml` | typecheck + all tests + Docker smoke test + **both APKs → GitHub Release `build-N`** on every push |

The demo is deliberately **blank**: only the institution, the admin and the optional demo teacher/student named in the Render environment exist until someone adds data.

## 2. Links

- Latest APKs (always the newest build):
  - https://github.com/atul-kumar-jena/nonegit/releases/latest/download/attendly-institute.apk
  - https://github.com/atul-kumar-jena/nonegit/releases/latest/download/attendly-student.apk
  - https://github.com/atul-kumar-jena/nonegit/releases/latest/download/attendly-apps.zip
- Zips kept in the branch, each with INSTALL.txt: `downloads/Attendly-Apps.zip`, `downloads/Attendly-Institute.zip`, `downloads/Attendly-Student.zip`
  (raw: `https://github.com/atul-kumar-jena/nonegit/raw/claude/three-secure-synced-apps-42sdud/downloads/<name>.zip`)
- CI runs: https://github.com/atul-kumar-jena/nonegit/actions

## 3. Rules for whoever continues

1. **Branch:** develop, commit and push only on `claude/three-secure-synced-apps-42sdud`, with `git push -u origin claude/three-secure-synced-apps-42sdud`. **No pull request** unless the owner asks for one.
2. **Never put secrets in the repo or a chat.** The Supabase password and connection string go only into Render → Environment. The same goes for `SERVER_SIGNING_KEY`, `TOKEN_PEPPER` and `DEV_TOOLS_TOKEN`.
3. **A push cancels the CI run already in progress** on the branch (`concurrency: cancel-in-progress`). If you are waiting for APKs, wait until the run finishes before pushing again.
4. The app must **never crash**: every native call (camera, notifications, location, background tasks) is wrapped and degrades gracefully. Every button must do something real.
5. Keep the **server as the only source of truth**. Apps may queue offline actions, but the server decides, and uniqueness lives in database constraints.
6. Every change a staff member makes goes through the **audit log** (`server/src/lib/audit.ts`).
7. Update `docs/TESTING.md`, `docs/HOW-IT-WORKS.md` and this file when behaviour changes.

## 4. Architecture map

### Monorepo (npm workspaces)

```
packages/protocol/src
  crypto.ts, qr.ts, geo.ts, attendance.ts   signatures, rotating QR tokens, geofence, % maths
  schemas.ts, staff.ts, timetable.ts         the API contract (zod) shared by server and apps
  planner.ts                                 pure planner engine: DraftOp union, applyOps, findConflicts,
                                             upsertOp / moveOp / swapOps / removeOpsFor, date helpers
packages/app-kit/src
  lib/api-core.ts      signed client: authed() (token + device signature), keySigned() (device key only)
  lib/vault.ts         XChaCha20-Poly1305 store, key in SecureStore
  lib/outbox.ts        offline queue with idempotent clientRefs; OutboxRunner / flushOutboxNow
  lib/notifications.ts bell + list, phone notifications (channel 'timetable-alerts', MAX importance,
                       default sound), 15-min background check, NotificationRunner, permissions onboarding
  lib/permissions.ts   location / notification permission items, openAppSettings
  screens/             Login, Verify, Bind, Notifications, Permissions
  state/session.tsx    session phases, audience guard (student vs staff app)
server/
  migrations/001..004  init, institute, present (big screen), timetable_v2 (batches, drafts,
                       notifications, slot_date + change columns on class_sessions)
  src/routes/          auth, meta, attendance, student, staff-sessions, staff-academics,
                       staff-admin, staff-planner (batches, planner, drafts, adjust, availability,
                       notifications), present (/present page + pairing), dev (/dev codes page)
  src/lib/             access (scoping; teachers see own + substituted classes), planner-server
                       (publishOps: validate → apply → notify → audit, one transaction), notify
                       (one grouped notification per person), batches (reconcileBatchEnrollments),
                       timetable (materializer: one class per slot per day, never overwrites
                       adjusted classes), audit (hash chain)
apps/institute/
  app/(app)/(tabs)     home (Today), timetable, classes, more
  app/(app)/           attend, session/[id], live/[id], register/[id], course/*, slot-form,
                       extra-class, roster, people/*, import, rooms, requests, flags, institution,
                       setup, batches, batch/[id], busy, planner, notifications, permissions
  src/planner/         useDraft (autosave, version check → 409 handling, offline backup),
                       Board (PanResponder drag, long-press 230 ms, edge auto-scroll, drop = swap),
                       layout, describe
  src/components/      AppLock (overlay), BigScreen, Adjust (AdjustSheet, TeacherPicker, ConflictList)
apps/student/
  app/(app)/(tabs)     home, timetable, subjects, profile
  app/(app)/           scan, result, subject/[id], notifications, permissions
  src/components/      QrScanner (whole-frame detection, lock-on box, tap-to-focus, pinch + 1×/2×/4×,
                       torch), ChangeNote
```

### Key mechanisms (one line each)

- **Auth:** email OTP → bind an Ed25519 device key (one active phone per person). Every request is signed over (method, path, ts, nonce, body hash) plus a bearer token. Refresh tokens rotate; reuse revokes the family.
- **QR:** `HMAC(session secret, session‖seq)`, rotating every few seconds. The scan is checked for enrolment, device, GPS freshness, accuracy, mock location and geofence.
- **Big screen:** `/present` shows an 8-character code (5 min, single use, stored as an HMAC). The teacher approves it in the app. The screen polls with a secret (stored as sha256) and gets only an SVG of the current QR.
- **Timetable:**
  - Weekly slots are materialized 14 days ahead into `class_sessions`, unique on `(slot_id, slot_date)`.
  - Adjusted classes carry `change_kind` / `original_start` / `substitute_id`, and the materializer leaves them alone.
  - Clash rules: the same teacher, room or course overlapping is an **error**; shared students overlapping is a **warning** (`acceptWarnings`). Only clashes a change *introduces* count.
- **Drafts:** `timetable_drafts` with a `version`. Saving with a stale version returns 409. Publish runs every op in one transaction.
- **Notifications:**
  - `notifications` table; `GET /v1/notifications` for the list.
  - `GET /v1/notifications/poll` is signed by the device key only (header `x-attendly-key`), for the background task.
- **Offline:**
  - Persisted React Query cache.
  - Outbox for scans, class start/end and registers.
  - Teacher "offline pack" (classes and QR secrets for today and tomorrow).
  - Scans are judged at scan time (up to 24 h late).

## 5. Commands

```bash
npm install
npm run typecheck                       # protocol, app-kit, server, both apps
npm test -w packages/protocol           # 41 tests
npm test -w server                      # 82 tests; needs Postgres at postgres://postgres@127.0.0.1:5432/postgres
npm test -w packages/app-kit            # 15 tests
npm test -w apps/institute              # 8 tests
npm run build -w server                 # esbuild → server/dist/server.cjs
(cd apps/institute && npx expo export --platform android)   # bundle check (CI does both apps)
```

Two-app browser rehearsal: see `e2e/README.md`. In short:

1. Build the web exports with `EXPO_PUBLIC_ALLOW_HTTP=1`.
2. `bash e2e/reset-server.sh`.
3. `NODE_PATH=$(npm root -g) OUT=/tmp/shots node e2e/both.cjs`. It must end with `ERRORS: []`.

Tricks already learned:

- Chromium's emulated geolocation freezes timestamps, so the script calls `setGeolocation` before each scan.
- The OTP list on `/dev` is newest-first.
- Some text exists twice in the DOM (hidden tab screens), so the script uses `.last()`.

### How APKs are released

Every push to the branch runs CI:

1. The `test` job runs.
2. The `android-apk` matrix builds the student and institute APKs.
3. The `release` job publishes tag `build-<run_number>` with `attendly-student.apk`, `attendly-institute.apk` and `attendly-apps.zip`. `/releases/latest/download/…` always points at it.

To refresh the zips in `downloads/`, download the release assets, zip each APK with `INSTALL.txt`, and commit.

## 6. Deploying (summary of DEPLOY.md)

1. **Supabase:** create a project → **Connect → Session pooler** URI (not "Direct"; Render can't reach IPv6). Optionally download the SSL certificate.
2. **Render:** New → Blueprint → this repo and branch (`render.yaml`). Enter:
   - `DATABASE_URL`, and optionally `DATABASE_SSL_CA`.
   - `BOOTSTRAP_INSTITUTION_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME`.
   - Optionally `BOOTSTRAP_DEMO_TEACHER_EMAIL` and `BOOTSTRAP_DEMO_STUDENT_EMAIL`.

   Blank values count as unset. Keys are generated by Render.
3. Check `https://<service>/v1/meta`.
4. Sign-in codes while testing: `https://<service>/dev?token=<DEV_TOOLS_TOKEN>`.
5. Going live:
   - Email codes: `OTP_DELIVERY=smtp` + `SMTP_URL` + `SMTP_FROM`, then delete `DEV_TOOLS_TOKEN`.
   - Use a paid Render plan (the free plan sleeps).
   - Pin the server into the builds: set the GitHub Actions variables `ATTENDLY_API_URL` and `ATTENDLY_SERVER_KEY`.

## 7. Known limits → next steps (in priority order)

1. **Instant push when the app is fully closed.** Today phone notifications come while the app is open, plus a background check about every 15 minutes (Android may delay it under battery saver; iOS decides the timing itself). For instant delivery:
   - Create a Firebase project and add `google-services.json`.
   - Store Expo push tokens per device (new table plus a `POST /v1/devices/push-token` route).
   - Send through Expo's push API from `deliverChanges` in `server/src/lib/notify.ts`.
2. **Email / SMS for sign-in codes** in production: SMTP is ready. SMS needs a provider (MSG91 / Twilio) behind `SMS_DELIVERY`.
3. **Hardware attestation** (Play Integrity / App Attest). It needs the owner's Google Cloud and Apple accounts. Root, emulator and mock-location signals are enforced today.
4. **iOS builds** need an Apple developer account (EAS). The code is cross-platform.
5. **Play Store release:** app signing key, privacy policy (camera, location and notifications are explained in-app already), store listing.
6. Product ideas that would help sell it to colleges:
   - Parent/guardian SMS for low attendance.
   - Leave / medical requests with approval.
   - Per-department HOD role.
   - Exam-eligibility report (below minimum %).
   - Multi-campus dashboards.
   - A web admin console that reuses the same API.
   - Paid tiers per active student.
7. Web builds are for testing only. Release apps require HTTPS and a real phone.

## 8. Verification status at handoff

- 146 automated tests pass: protocol 41, server 82, app-kit 15, institute 8.
- The 29-step two-app browser run passes with `ERRORS: []`. It covers:
  - Onboarding and the wrong-app guard.
  - Uniqueness checks, import, timetable.
  - Big-screen pairing, scan, register.
  - Teacher offline and student offline.
  - Subject planner, CSV export.
  - Planner drag → publish → student bell → "Moved from…".
- CI builds both APKs on every push. The phone-only parts (real camera autofocus, system notification sound, background check timing, biometrics) have to be checked by hand with `docs/TESTING.md`.
