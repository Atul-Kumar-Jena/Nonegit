# Attendly — attendance, unforgeable.

Three apps that sync through one secure backend:

| # | App | Who | Status |
|---|-----|-----|--------|
| 1 | **Attendly Student** (`apps/student`) | Students scan a rotating QR inside a geofence | ✅ **Built** |
| 2 | Attendly Admin | Faculty run sessions, watch live scans, review suspicious attempts, approve device switches | ⏳ Next — prompt in [`docs/PROMPTS.md`](docs/PROMPTS.md) |
| 3 | Attendly Developer | Kill switches, feature flags, audit log, tenants, key rotation | ⏳ Later — prompt in [`docs/PROMPTS.md`](docs/PROMPTS.md) |

The backend (`server/`) and the shared crypto/contract package (`packages/protocol/`) are already built for all three, so the apps can never drift out of sync.

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
| Tests | Vitest + real PostgreSQL + Playwright | 90 automated tests, plus a browser-driven run of the whole student journey. |
| CI | GitHub Actions | Typecheck, all tests, Docker image smoke test, and a downloadable **Android APK** on every push. |

## How the three apps sync securely

```
 Student phone                       Attendly API (single source of truth)                 Faculty phone (App 2)
 ─────────────                       ─────────────────────────────────────                 ────────────────────
 Ed25519 device key  ──signed req──▶  verify signature · nonce · timestamp      ◀──signed──  shows rotating QR
 (Keychain/Keystore)                  verify QR MAC · freshness · geofence                   (HMAC of session secret,
 scans rotating QR                    one-device + one-mark constraints (Postgres)            changes every 3–15 s)
 verifies receipt  ◀──Ed25519 receipt─ append to hash-chained audit log  ──────────────────▶  live feed / flags
                                                                          ◀─────────────────  Developer app (App 3)
```

What stops proxy attendance and forged records:

1. **One student, one phone.** On first sign-in the phone generates an Ed25519 key that never leaves the device. The server binds it to the student. A second phone can only *request* a switch, which an admin must approve.
2. **Every API call is signed.** The request carries the method, path, timestamp, a random nonce and a SHA-256 of the body, all signed by the device key. A stolen login token is useless without the phone. Replays and requests with a skewed clock are refused.
3. **The QR can't be forged and goes stale fast.** Each token is `HMAC-SHA256(session secret, session‖seq)` and rotates every few seconds. A screenshot sent to a friend expires almost immediately.
4. **Location.** The phone must be inside the room's geofence. The server rejects fixes flagged by the OS as mock locations, fixes reporting perfect 0 m accuracy (a classic fake-GPS sign), stale fixes and imprecise ones. Every refusal is logged for the faculty member to review.
5. **Verifiable receipts.** The server signs every accepted mark with its own Ed25519 key. The app pins that key on first connect and verifies each receipt, so the "ed25519 ✓ verified" line on the success screen is a real check.
6. **Tamper-evident history.** Every sign-in, binding, mark and rejection goes into an append-only audit log. Each entry includes the SHA-256 of the previous one, and the database forbids UPDATE and DELETE on it. `npm run audit:verify -w server` recomputes the chain and reports the first altered entry.
7. **Secrets at rest.** OTP codes, access/refresh tokens and tickets are stored only as HMAC hashes, keyed with a server-side pepper.
8. **Tokens.** Access tokens last 15 minutes. Refresh tokens rotate on every use, and reusing an old one revokes the whole session family.

The test suite also covers what an independent code review found and I fixed: re-binding a phone after an admin unbinds it, a 100% attendance rule, rate-limited refreshes on campus NAT, and pauses that must never lock students out.

**Honest limits** (and where they get closed):
- Hardware attestation (Google Play Integrity / Apple App Attest) isn't wired in yet. Today the app reports root/jailbreak and emulator signals, which the server enforces. Real attestation needs your own Google Cloud and Apple accounts, and it's planned for App 3's "feature flags" work.
- The server key pin is trust-on-first-use. For the strongest setup, bake the key into the build with `EXPO_PUBLIC_SERVER_KEY`.
- A determined cheater with a rooted phone that hides its root status could still fake GPS. The rotating QR, device binding and the audit trail make that slow, visible and attributable.

## Repository layout

```
packages/protocol/   shared crypto, QR tokens, geofence + 75%-rule maths, API schemas, error codes (+ unit tests)
server/              Fastify API, SQL migrations, CLI (keys / migrate / seed / session:start / audit:verify), tests
apps/student/        App 1: Expo app, all 9 screens from the design (+ end-to-end client tests)
docs/PROMPTS.md      exact prompts for building App 2 and App 3
.github/workflows/   CI + Android APK build
```

---

## 1 · Run everything on your computer (≈10 minutes)

**You need:** [Node.js 22](https://nodejs.org), and either [Docker Desktop](https://www.docker.com/products/docker-desktop/) or a PostgreSQL 16 install.

```bash
git clone https://github.com/atul-kumar-jena/nonegit.git attendly && cd attendly
git checkout claude/three-secure-synced-apps-42sdud
npm install

# Server config
cp server/.env.example server/.env
npm run keys -w server          # paste the three printed lines into server/.env
```

In `server/.env`, set `DATABASE_URL` to your Postgres URL. Then:

```bash
# Option A — Postgres via Docker
docker run -d --name attendly-db -e POSTGRES_USER=attendly -e POSTGRES_PASSWORD=attendly -e POSTGRES_DB=attendly -p 5432:5432 postgres:16-alpine

npm run seed -w server          # demo institution, 11 students, 5 courses, 11 weeks of history
npm run dev -w server           # API on http://localhost:4000
```

To sign in as yourself instead of the demo student, set `SEED_STUDENT_EMAIL=you@gmail.com` in `server/.env` before seeding (add `-- --reset` to re-seed).

## 2 · Test the Student app on your phone

> **Easiest path, no computer setup:** follow **[docs/TESTING.md](docs/TESTING.md)**. It covers a one-click free server on Render, a direct APK link, and a 20-step checklist with expected results.


### Option A: Expo Go (fastest, no build)

1. Install **Expo Go** from the Play Store / App Store. It must be the version for SDK 57.
2. Put your phone and computer on the **same Wi-Fi**. Find your computer's LAN IP (e.g. `192.168.1.20`).
3. Start the app:
   ```bash
   cd apps/student
   EXPO_PUBLIC_API_URL=http://192.168.1.20:4000 npx expo start
   ```
4. Scan the QR code in the terminal with Expo Go (Android) or the Camera app (iPhone).
5. Sign in as **`aarav@demo.attendly.app`**. The 6-digit code is printed in the **server terminal**, because `OTP_DELIVERY=console`.
6. Tap **Bind this device**. The dashboard shows Aarav's real term history.

### Scanning a live class QR (before App 2 exists)

The server includes a **testing-only faculty console**:

1. Make sure `DEV_TOOLS_TOKEN` is set in `server/.env` (`npm run keys` prints one).
2. On your **computer**, open `http://localhost:4000/dev?token=<DEV_TOOLS_TOKEN>`.
3. Click **Use this computer's location**, or paste your coordinates from Google Maps for better accuracy. Pick a **250 m radius** while testing, since laptop location can be off by a lot. Then click **Go live here** on today's CS-301 class, or **Start new session**.
4. A rotating QR appears. In the Student app, tap the glowing **Scan** button and point it at the screen. You'll see **Marked present · ed25519 ✓ verified**.
5. To see a rejection, start a session with coordinates a few kilometres away. You'll get **E-GEO · Outside geofence**.

Two more things to try:
- Sign in as the same student on a second phone to see the **device switch** request.
- Run `npm run audit:verify -w server` to check the audit chain.

> Testing on an Android emulator or iOS simulator? Set `ALLOW_EMULATORS=true` in `server/.env`. Real deployments must leave it `false`.

### Option B: Install a real APK (Android)

Every push to GitHub builds an installable APK:

1. The APK needs to reach your server over **HTTPS**. For a quick test, expose your local server with a free Cloudflare tunnel (no account needed):
   ```bash
   cloudflared tunnel --url http://localhost:4000      # prints https://something.trycloudflare.com
   ```
   Also set `TRUST_PROXY=true` in `server/.env`.
2. On GitHub: **Settings → Secrets and variables → Actions → Variables → New variable**: `ATTENDLY_API_URL` = your https URL. It's optional; without it, the app asks for the server address on first launch.
3. **Actions → CI → latest run → Artifacts → `attendly-student-apk`**. Download it, unzip it, open `app-release.apk` on your phone, and allow "install unknown apps".

### Option C: EAS (Expo's cloud builds; Android APK or iOS)

```bash
npm i -g eas-cli && eas login          # free Expo account
cd apps/student
eas build -p android --profile preview # link to an installable APK
eas build -p ios --profile preview     # needs an Apple Developer account ($99/yr)
```

## 3 · Put the server on the internet (for real use)

The image is a single container plus PostgreSQL.

- **Any VPS:** `docker compose up -d` (see `docker-compose.yml`), behind Caddy or Nginx for HTTPS.
- **Render / Railway / Fly.io:** deploy `server/Dockerfile`, add a managed Postgres (Neon, Supabase…), and set the env vars from `server/.env.example`. Set `DATABASE_SSL=true`, `TRUST_PROXY=true` and `OTP_DELIVERY=smtp` (with `SMTP_URL`), and leave `DEV_TOOLS_TOKEN` **empty**.

Migrations run automatically on boot. Liveness check: `GET /healthz`.

## 4 · Tests & checks

```bash
npm run typecheck                      # protocol + server + app
npm test -w packages/protocol          # 28 unit tests (RFC 8032 vector, OpenSSL interop, malleability, QR, geofence, 75% maths)
npm test -w server                     # 47 integration tests on real Postgres (replay, tampering, token theft, refresh reuse, OTP lockout, fake GPS, concurrency…)
npm test -w apps/student               # 15 tests: the phone's API client over HTTP against the real server + 20,000 fuzzed server addresses
```

The server tests need Postgres at `postgres://postgres@127.0.0.1:5432/postgres`; override with `TEST_DATABASE_URL`. Each test file gets its own throwaway database.

The security tests were checked by **mutation testing**: I deliberately removed each of 9 security checks (QR freshness, nonce replay, device signature, mock-GPS, QR MAC, tenant isolation, refresh-reuse detection, OTP lockout, root detection), and the suite failed every time.

## Configuration reference

All server settings are in [`server/.env.example`](server/.env.example), with comments. The Student app reads:

| Variable | Meaning |
|---|---|
| `EXPO_PUBLIC_API_URL` | Default server address (users can still change it on the sign-in screen). |
| `EXPO_PUBLIC_SERVER_KEY` | Optional: pin the server's receipt key at build time (from `GET /v1/meta` → `serverKey.publicKey`). |
| `EXPO_PUBLIC_ALLOW_HTTP` | `1` only for local testing builds. Release builds require HTTPS. |

## Known advisories

`npm audit` reports moderate advisories in `uuid` and `decode-uri-component`. They come from Expo's **build-time CLI** tooling, not from code that ships inside the app or the server bundle. They clear when Expo updates those dependencies.
