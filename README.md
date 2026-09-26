# Attendly — attendance, unforgeable.

| App | Who | What it does |
|---|---|---|
| **Attendly Institute** (`apps/institute`) | Admins, teachers | Onboard the institution (rooms, teachers, courses, batches, students by paste, weekly timetable). **Drag-and-drop timetable planner** with drafts → review → publish, one-tap class adjustments (move / substitute / cancel) with clash checks, and a **who's busy** view. Run classes with a rotating QR on the phone **or on a laptop/smartboard paired from the app**, or a paper-style register with a clear manual warning. Live feed, corrections, reports + CSV, phone approvals, suspicious-scan review. App lock, screenshots blocked. |
| **Attendly** (`apps/student`) | Students | Telegram-style QR scanner (finds the code anywhere, tap-to-focus, zoom), signed receipts, attendance per subject, "how many can I miss", a **plan-ahead** calculator, history, weekly timetable with change notes, **loud notifications** when a class is moved/cancelled/substituted, offline scans. |
| **Server** (`server/`) | — | The single source of truth, deployed on **Render** with **Supabase** Postgres. |

📥 **Download:** [attendly-institute.apk](https://github.com/atul-kumar-jena/nonegit/releases/latest/download/attendly-institute.apk) · [attendly-student.apk](https://github.com/atul-kumar-jena/nonegit/releases/latest/download/attendly-student.apk)
📖 **Read next:** [How it works](docs/HOW-IT-WORKS.md) (onboarding → marking, uniqueness, offline, big screen) · [Deploy](docs/DEPLOY.md) (Supabase + Render) · [Test on phones](docs/TESTING.md) (54-step checklist) · [Handoff](docs/HANDOFF.md) (everything needed to continue the work)

---

## Tech stack (and why)

| Layer | Choice | Why |
|---|---|---|
| Mobile apps | **React Native 0.86 + Expo SDK 57**, TypeScript (strict), expo-router | One codebase for Android + iOS; a native camera, GPS, Keychain/Keystore and biometrics; you can install an APK without app-store approval. |
| Crypto | **Ed25519** + **SHA-256/HMAC** from the audited [`@noble`](https://paulmillr.com/noble/) libraries | The same code runs on the phone and the server. Verification is strict RFC 8032, so malleable signatures are rejected (there's a test for it). |
| API | **Fastify 5** on Node 22 | Fast and well maintained, with schema-validated routes and built-in rate limiting. |
| Database | **PostgreSQL 16** | Transactions and unique constraints enforce "one student, one device" and "one mark per session" at the database level. |
| Contract | **zod** schemas shared by the server and apps | Every request and response is validated on both sides. A mismatch shows a clean error; it never crashes. |
| Data fetching | TanStack Query | Caching, retry with backoff, refresh when the app returns to the foreground, offline display. |
| Offline | Encrypted on-device store (XChaCha20-Poly1305, key in Keystore/Keychain) + an upload queue with one-time IDs | Classes run and scans are captured with no internet, and upload exactly once later. |
| Tests | Vitest + real PostgreSQL + Playwright | 146 automated tests, plus a 29-step browser run of both apps together (online and offline). |
| CI | GitHub Actions | Typecheck, all tests, Docker image smoke test, and **both Android APKs** published on every push. |

## How the apps sync securely

```
 Student phone                       Attendly API (single source of truth)                 Teacher phone (Institute)
 ─────────────                       ─────────────────────────────────────                 ────────────────────
 Ed25519 device key  ──signed req──▶  verify signature · nonce · timestamp      ◀──signed──  shows rotating QR
 (Keychain/Keystore)                  verify QR MAC · freshness · geofence                   (HMAC of session secret,
 scans rotating QR                    one-device + one-mark constraints (Postgres)            changes every 3–15 s)
 verifies receipt  ◀──Ed25519 receipt─ append to hash-chained audit log  ──────────────────▶  live feed / flags
                                                                          ◀─────────────────  classroom big screen (/present,
                                                                                              paired from the teacher's app)
```

What stops proxy attendance and forged records:

1. **One student, one phone.** On first sign-in the phone generates an Ed25519 key that never leaves the device. The server binds it to the student. A second phone can only *request* a switch, which an admin must approve.
2. **Every API call is signed.** The request carries the method, path, timestamp, a random nonce and a SHA-256 of the body, all signed by the device key. A stolen login token is useless without the phone. Replays and requests with a skewed clock are refused.
3. **The QR can't be forged and goes stale fast.** Each token is `HMAC-SHA256(session secret, session‖seq)` and rotates every few seconds. A screenshot sent to a friend expires almost immediately.
4. **Location.** The phone must be inside the room's geofence. The server rejects fixes flagged by the OS as mock locations, fixes reporting perfect 0 m accuracy (a classic fake-GPS sign), stale fixes and imprecise ones. Every refusal is logged for the teacher to review.
5. **Verifiable receipts.** The server signs every accepted mark with its own Ed25519 key. The app pins that key on first connect and verifies each receipt, so the "ed25519 ✓ verified" line on the success screen is a real check.
6. **Tamper-evident history.** Every sign-in, binding, mark and rejection goes into an append-only audit log. Each entry includes the SHA-256 of the previous one, and the database forbids UPDATE and DELETE on it. `npm run audit:verify -w server` recomputes the chain and reports the first altered entry.
7. **Secrets at rest.** OTP codes, access/refresh tokens and tickets are stored only as HMAC hashes, keyed with a server-side pepper.
8. **Tokens.** Access tokens last 15 minutes. Refresh tokens rotate on every use, and reusing an old one revokes the whole session family.

The test suite also covers what an independent code review found and I fixed: re-binding a phone after an admin unbinds it, a 100% attendance rule, rate-limited refreshes on campus NAT, and pauses that must never lock students out.

**Honest limits** (and where they get closed):
- Hardware attestation (Google Play Integrity / Apple App Attest) isn't wired in yet. Today the app reports root/jailbreak and emulator signals, which the server enforces. Real attestation needs your own Google Cloud and Apple accounts, and it's planned for the Developer app.
- The server key pin is trust-on-first-use. For the strongest setup, bake the key into the build with `EXPO_PUBLIC_SERVER_KEY`.
- A determined cheater with a rooted phone that hides its root status could still fake GPS. The rotating QR, device binding and the audit trail make that slow, visible and attributable.

## Repository layout

```
packages/protocol/   shared crypto, QR tokens, geofence + attendance maths, planner engine, API schemas (+ unit tests)
packages/app-kit/    shared app code: signed API client, encrypted vault, offline outbox, sign-in, notifications, permissions, UI
server/              Fastify API, SQL migrations, big-screen page (/present), CLI, integration tests
apps/institute/      Attendly Institute (admins + teachers)
apps/student/        Attendly (students)
docs/                HOW-IT-WORKS · DEPLOY · TESTING · HANDOFF · PROMPTS
e2e/                 29-step two-app browser rehearsal (Playwright)
.github/workflows/   CI: typecheck, tests, Docker smoke test, both APKs → GitHub Release
```

## Run everything on your computer

**You need:** [Node.js 22](https://nodejs.org) and PostgreSQL 16 (or Docker).

```bash
git clone https://github.com/atul-kumar-jena/nonegit.git attendly && cd attendly
git checkout claude/three-secure-synced-apps-42sdud
npm install
cp server/.env.example server/.env
npm run keys -w server          # paste the printed lines into server/.env; set DATABASE_URL
npm run dev -w server           # API on http://localhost:4000 (creates the tables)
```

Set `BOOTSTRAP_INSTITUTION_NAME` and `BOOTSTRAP_ADMIN_EMAIL` in `server/.env` to create your institution and admin on start (or `npm run seed -w server` for a populated demo). Sign-in codes print in the server terminal (`OTP_DELIVERY=console`).

Run the apps with Expo (same Wi-Fi as the computer):

```bash
cd apps/institute && EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000 npx expo start
cd apps/student   && EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000 npx expo start
```

## Tests & checks

```bash
npm run typecheck                 # protocol, server, both apps
npm test -w packages/protocol     # crypto vectors, OpenSSL interop, malleability, QR epochs, attendance maths
npm test -w server                # real PostgreSQL: roles, scoping, uniqueness, replays, tampering, offline sync, registers, timetable, big-screen pairing, batches, adjustments, drafts, notifications
npm test -w packages/app-kit      # signed API client over HTTP + 20,000 fuzzed server addresses
npm test -w apps/institute        # spreadsheet-paste parser, planner layout
```

Server tests need Postgres at `postgres://postgres@127.0.0.1:5432/postgres` (override with `TEST_DATABASE_URL`); each file gets a throwaway database. The security checks were verified by mutation testing: removing any of them makes the suite fail.

## Configuration reference

Server: [`server/.env.example`](server/.env.example) and [`render.yaml`](render.yaml). Apps (build-time):

| Variable | Meaning |
|---|---|
| `EXPO_PUBLIC_API_URL` | Default server address (people can still change it on the sign-in screen). |
| `EXPO_PUBLIC_SERVER_KEY` | Pin the server's receipt key at build time (`GET /v1/meta` → `serverKey.publicKey`). |
| `EXPO_PUBLIC_ALLOW_HTTP` | `1` only for local testing builds. Release builds require HTTPS. |
