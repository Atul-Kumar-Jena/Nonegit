# Testing App 1 (Student) on a real phone

This procedure was rehearsed end-to-end against a production-mode server before release. You need:

- an **Android phone** (for the app),
- a **laptop, tablet or second phone** with a browser (it displays the class QR the phone scans),
- about **20 minutes**. It's free and needs no credit card.

---

## Part A · Put the server online (once, ~10 min)

The app needs a server on the internet. The repository includes a one-click setup for **Render**, which is free:

1. Go to **https://dashboard.render.com** and sign up with **GitHub**.
2. Click **New +** → **Blueprint**.
3. Choose the repository **Atul-Kumar-Jena/Nonegit**. If it isn't listed, click "Configure GitHub" and allow it, or paste the repo URL.
4. **Branch:** `claude/three-secure-synced-apps-42sdud`. Render finds `render.yaml` and shows **attendly-api** + **attendly-db**. Click **Apply**.
5. Wait until **attendly-api** shows **Live**. The first build takes 5–10 minutes.
6. Open **attendly-api** and copy its address at the top, e.g. `https://attendly-api-ab12.onrender.com`. This is your **SERVER ADDRESS**.
7. In the same service, open **Environment** and copy the value of **DEV_TOOLS_TOKEN**. This is your **CONSOLE TOKEN**.
8. **Check:** open `SERVER ADDRESS/healthz` in a browser. You should see `{"ok":true}`.

The demo institution (11 students, 5 courses, 11 weeks of history) is created automatically on first start.

> The free server sleeps after 15 minutes without use. The first request after that takes up to a minute; the app waits and tells you so.

## Part B · Open the testing console (on the laptop)

Open **`SERVER ADDRESS/dev?token=CONSOLE TOKEN`**, e.g.
`https://attendly-api-ab12.onrender.com/dev?token=Sj1F...`

You'll see the **Faculty test console**. It has two jobs:

- **Sign-in codes:** codes appear here instead of being emailed (test mode).
- **Start a live session:** shows the rotating QR that students scan.

Keep this page open.

## Part C · Install the app (on the phone)

1. On the phone, open **https://github.com/Atul-Kumar-Jena/Nonegit/releases/latest** and tap **attendly-student.apk**.
2. Open the downloaded file. If asked, allow **"Install unknown apps"** for your browser, then tap **Install**.
   Play Protect may warn about an unknown developer; tap **More details → Install anyway**. It warns because this is a test build.

## Part D · Test checklist

Do these in order. Each step says what you should see.

| # | Do this | You should see |
|---|---|---|
| 1 | Open **Attendly** | Splash, then **"Connect to your institution"** |
| 2 | Type a wrong address, e.g. `https://.....trycloudflare.com`, then **Connect** | A red message: *"That address has an empty part between dots…"*. The app stays open. |
| 3 | Type `https://trycloudflare.com` (a website, not a server) | *"That address answered, but it is not an Attendly server…"* or *"Couldn't reach that address…"* |
| 4 | Paste your **SERVER ADDRESS**, then **Connect** | "Connecting…", then the **Sign in** screen |
| 5 | Email: `aarav@demo.attendly.app`, then **Send OTP** | **Enter the code** |
| 6 | On the laptop console, read the 6-digit code under **Sign-in codes**, and type it on the phone | **Bind this device** (step 2 of 2) |
| 7 | Tap **Bind this device** | **Dashboard**: *Good morning, Aarav Reddy*, term attendance **83%**, Device *Bound*, today's CS-301 **Upcoming** |
| 8 | Tap **Subjects** | 5 subjects; **EC-204 AT RISK 72%**, *"Attend next 3 to reach 75%"* |
| 9 | Tap **Profile** | Aarav Reddy · 21CS1108, bound device with your phone model, *Reset requests 0 / 2* |
| 10 | On the laptop: **Use this computer's location** and keep **Radius 250**. Then click **Go live here** next to CS-301 under *Today's timetable*. (If there is no timetable, e.g. you're testing on a later day, keep Course = CS-301 and click **Start new session →**.) | A big rotating QR; the number under it changes every 7 s |
| 11 | On the phone: pull down on Home to refresh | CS-301 shows **LIVE** and a **Scan** button |
| 12 | Tap **Scan**, allow camera + location, and point at the laptop QR | **Marked present**, **SIGNATURE ed25519 ✓ verified**, CS-301 attendance goes up. The laptop shows **1 / 11 marked**. |
| 13 | Back on Home, the CS-301 card now says **Present**. Tap the big round **scan button** in the bottom bar and scan the same QR again. | **Already marked** (no duplicate record) |
| 14 | **Geofence test:** on the laptop, **End** the session. Type latitude `0` and longitude `0`, then **Start new session** | New QR |
| 15 | Scan it with the phone | **Attendance rejected · E-GEO · Outside geofence**, with your distance in metres |
| 16 | **Foreign QR:** tap Scan and point at any product or website QR | Yellow hint *"That's not an Attendly session code."*; nothing is sent to the server |
| 17 | **Offline:** turn on airplane mode and pull to refresh on Home | The badge changes to **Offline**; the app keeps showing your data and doesn't crash |
| 18 | Turn airplane mode off. Go to **Profile → Request device reset**, type a reason, and send | *"Reset requested … waiting for your admin"*; the counter shows **1 / 2** |
| 19 | **Profile → Sign out**, then sign in again (steps 5–6) | Goes straight to the Dashboard (no re-binding: same phone) |
| 20 | Optional, second phone: install the app and sign in as Aarav | **"Your account is bound to another phone"** → request a switch |

If you tested near the laptop and step 12 shows **E-GEO**, the laptop's location estimate was off. On the console, set **Radius 1000** and start a new session. You can also long-press your spot in Google Maps and type those coordinates into the console.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Couldn't reach that address" | Check the address in a browser: `SERVER ADDRESS/healthz` must show `{"ok":true}`. On the free plan, wait a minute and retry. |
| No code on the console | Check you used the exact email `aarav@demo.attendly.app`. Wait 30 s between code requests. |
| Console page says `{"error":…"NOT_FOUND"}` | The token in the URL is wrong. Copy DEV_TOOLS_TOKEN again from Render → Environment. |
| "Too many attempts" | Wait a minute (anti-abuse limits). |
| After reinstalling, Aarav says "bound to another phone" | Expected and correct: uninstalling deletes the phone's key, and only an admin (App 2) can approve a new binding. For more testing, sign in as another demo student: `priya@demo.attendly.app`, `rohan@demo.attendly.app`, `aanya@demo.attendly.app`, `vikram@demo.attendly.app` … |

---

### What was verified automatically before this build

- **90 automated tests.** Protocol maths and crypto, server security (replays, tampering, token theft, fake GPS, races), the app's network client over real HTTP, and 20,000 fuzzed server addresses (none can reach the network layer unvalidated).
- **A scripted browser rehearsal of Parts B–D** (steps 1–12), against a production-mode server with Render-style secrets.
- **The console QR decoded from screen pixels** into a valid session token.
