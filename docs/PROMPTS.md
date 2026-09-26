# Prompts for the next apps

Paste one of these as your next message, and attach **`Attendly___Print.pdf`** again. Each prompt names exact files, screens and rules, so the work builds on what exists instead of reinventing it.

---

## Prompt for App 2: Attendly Admin (faculty)

```
Build App 2 of Attendly: the ADMIN (faculty) app. The design is pages 8–12 of the attached
Attendly___Print.pdf ("02 / ROLES · Admin", 8 screens).

Repository: atul-kumar-jena/nonegit, branch claude/three-secure-synced-apps-42sdud.
App 1 (apps/student), the server (server/) and the shared package (packages/protocol/) already exist.
Read README.md, packages/protocol/src/*, server/src/** and apps/student/src/** BEFORE writing code,
and REUSE them. Do not duplicate crypto, schemas, theme or UI components.

Create apps/admin as a second Expo SDK 57 app in the same monorepo:
- Copy (or extract into a shared packages/ui) the theme, ui.tsx, Screen, Logo, OtpInput and
  api-core patterns from apps/student. Same sign-in: OTP → device binding → every request
  signed by the device key. Role must be 'admin'; refuse other roles with a clear message.
- Package id app.attendly.admin, name "Attendly Admin".

Screens (match the PDF exactly):
 01 Admin dashboard: active sessions, marked today, pending, suspicious counts, "Start new session",
    recent sessions list with a LIVE card.
 02 Create session: class picker, location (use the phone's current GPS as the geofence centre),
    radius 10/50/100 m, rotation 3/5/7/10/15 s, duration.
 03 Live QR: full-screen rotating QR with countdown, "#0024" sequence and session integrity panel.
    Enable screenshot blocking (expo-screen-capture / FLAG_SECURE) on this screen.
 04 Live scans feed: marked/pending counters, filters All/Recent/Flagged, auto-refresh.
 05 Suspicious scans: the scan_rejections rows with suspicious=true for the session;
    actions "Mark valid" (creates an attendance record with source='manual') and "Block · escalate".
 06 Bind / Unbind / Sudo queue: device_requests (rebind + reset) with Approve / Deny.
    Approving a rebind revokes the old device and activates the requested key (to_public_key);
    approving a reset revokes the current device. Revoke that device's sessions too.
    If the requested key is already bound to ANOTHER student, refuse the approval (one phone,
    one student) and say so in the UI.
 07 Reports · export: per-class summary, CSV export of raw attendance (share sheet).
    Mark PDF / Google Sheets as "coming soon" if not implemented; never add fake buttons.
 08 Profile · settings: classes I teach, 2FA/device info, sign out.

Server work (server/src/routes/admin.ts + a migration 002_*.sql if needed):
- Admin endpoints under /v1/admin/*, all using requireDevice(req, deps, ['admin']),
  and always scoped to the admin's tenant (and to courses they teach where it makes sense).
- QR generation: the admin app must render the QR OFFLINE from the session secret.
  Deliver qr_secret to the admin device only over the signed channel, only for its own
  live session, and never log it. Keep the token format in packages/protocol/src/qr.ts unchanged.
- Live feed: a polling endpoint that returns only changes since a cursor.
- Every admin action appends to the audit log (appendAudit) inside the same transaction.
- Add zod schemas for all new payloads to packages/protocol/src/schemas.ts.
- Replace the dev console (/dev) usage in README with the admin app, but keep /dev for testing.

Quality bar (same as App 1):
- TypeScript strict, zero type errors; no crashes: every screen has loading/error/empty states.
- Integration tests for every new endpoint in server/test (authorisation: a student and an admin
  from another tenant must be refused; approving a rebind really switches the device; manual mark
  is idempotent), and extend apps/*/test for the admin API client.
- All existing tests must still pass: npm run typecheck && npm test (all workspaces).
- Add an android-apk job for the admin app to .github/workflows/ci.yml.
- Commit and push to the same branch; update README.md and docs/PROMPTS.md.
- Tell me exactly how to install and test App 2 together with App 1.
```

---

## Prompt for App 3: Attendly Developer (root console)

```
Build App 3 of Attendly: the DEVELOPER (root) app. The design is pages 13–16 of the attached
Attendly___Print.pdf ("03 / ROLES · Developer", 5 screens).

Repository: atul-kumar-jena/nonegit, branch claude/three-secure-synced-apps-42sdud.
Apps 1 and 2, the server and packages/protocol already exist. Read README.md and docs/PROMPTS.md
first, and reuse the shared theme, UI, api-core and protocol. Create apps/developer
(Expo SDK 57, package app.attendly.developer), sign-in role 'developer' only.

Screens:
 01 Console: system health (active tenants, live sessions, scans/min, p99 latency from real
    server metrics), KILL SWITCHES backed by system_flags (scans_paused already exists and is
    enforced in server/src/routes/attendance.ts; add qr_rotation_frozen, new_bindings_blocked,
    public_api_disabled and ENFORCE each one server-side), sudo grant queue.
 02 Audit · merkle log: paginated audit_log with filters All/Auth/Scans/Admin/Crypto, and a
    "Verify chain" button that calls an endpoint running verifyAuditChain(). Upgrade the chain
    to periodic Merkle roots (store roots in a new table, signed with the server key) so one
    entry can be proven without replaying everything.
 03 Feature flags: tenant-scoped flags with percentage rollouts and scheduled flips
    (strict_geo, play_integrity_v3, screenshot_block, biometric_required, nfc_fallback,
    ble_proximity). Only implement enforcement for the flags that can actually be enforced;
    show the rest as "planned" and don't pretend.
 04 Tenants: list/search, inspect, suspend/resume (tenants.status is already enforced).
    "Impersonate" must be read-only, time-boxed, audited, and visibly bannered.
 05 Profile · keys: server signing-key rotation. Design this carefully: the Student app pins
    the key (apps/student/src/lib/server-config.ts). Publish the new key signed by the old key
    at /v1/meta, and teach the apps to accept a rotation only when that signature verifies.

Security requirements:
- Developer endpoints under /v1/dev-admin/* with requireDevice(req, deps, ['developer']).
- Every destructive action requires a fresh biometric confirmation in the app AND a second
  signed "confirm" request (two-step) on the server; everything is audited.
- Never expose secrets (QR secrets, peppers, private keys) through any endpoint.

Quality bar: TypeScript strict, loading/error/empty states everywhere, integration tests
for every endpoint (including role and tenant isolation), all existing tests green, a CI APK job,
README + docs updated, commit and push to the same branch, and tell me how to install and test it.
```

---

### Tips for good results

- Keep the PDF attached, because it's the visual source of truth.
- Build one app per message. After each one, test on your phone before asking for the next.
- If something looks off, send a screenshot plus the screen name from the PDF (e.g. "Admin 04 Live scans feed").
