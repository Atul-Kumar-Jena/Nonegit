# Testing both apps on real phones, start to finish

This is the exact journey the automated browser test runs before every release (29 steps, both apps, online and offline). Allow about an hour.

**You need**
- The server deployed: [DEPLOY.md](DEPLOY.md), sections 1–3. You'll need your **server address** and your **codes page** (`/dev?token=…`).
- **Phone A** (the teacher/admin): install **Attendly Institute**. It must have a screen lock (PIN, pattern or fingerprint).
- **Phone B** (the student): install **Attendly**.
- **A laptop** with a browser: the classroom "big screen", and where you read sign-in codes.
- Three email addresses: yours (admin), a teacher's, a student's. The demo accounts from deployment work.

APKs: `…/releases/latest/download/attendly-institute.apk` and `…/attendly-student.apk` (see DEPLOY.md §5).

---

## Part 1 · Admin sets up the institution (Phone A)

| # | Do this | You should see |
|---|---|---|
| 1 | Open **Attendly Institute**, paste the server address, **Connect** | **Sign in** — "for teachers and administrators" |
| 2 | Enter the admin email → **Send OTP**. Read the code on the laptop codes page and type it | **Bind this device** → the **Permissions** screen → **Allow all** → **Today**, with a violet **"Finish setting up"** card |
| 2b | *(once, any phone)* Refuse a permission | A one-time note: what stops working, and "change it later in Settings → Apps → … → Permissions" |
| 3 | Put the app in the background for 30 s, then reopen it | **Locked** → fingerprint/face/PIN → back where you were |
| 4 | Try a screenshot | Blocked (black image or "can't take screenshot") |
| 5 | Tap **Finish setting up** → **1. Check institution settings** → check time zone, term start and minimum % → **Save** | "Saved. Every app picks this up…" |
| 6 | **2. Add classrooms** → **Add** → name `LH-101` → *standing in the room*, **Use my location** → **Save room** | LH-101 with coordinates and "50 m" |
| 7 | **3. Add teachers** → **Add** → name + teacher email → **Add teacher** | The teacher's page: "No phone bound yet" |
| 8 | **4. Create courses** → code `cs-101` (it becomes `CS-101`), title, **Teacher** = your teacher → **Create course** | The course page, "No students enrolled" |
| 9 | Create `CS-101` again | Refused: already exists |
| 10 | **5. Add students** → paste rows from a sheet, e.g. `Name,Roll No,Email` then `Aarav Sharma,21CS001,aarav@…` → tick **CS-101** → **Add students** | "N added". Rows without an email/phone are listed as needing fixing |
| 11 | Paste the same student again → **Add** | "1 skipped" — email already used |
| 12 | **7. Build the timetable** → course CS-101, today's day, a time covering *now*, room LH-101, **QR scan** → **Add to timetable** | Back on the checklist: all required steps ticked; Today shows the class |
| 13 | Add another slot for the same teacher at an overlapping time | Refused: "already teaches … at an overlapping time" |

## Part 2 · Teacher runs a QR class on the big screen

| # | Do this | You should see |
|---|---|---|
| 14 | On Phone A, **More → Sign out**, then sign in with the **teacher** email | **Today** → the CS-101 class from the timetable, "Ready offline · 1 class…" |
| 15 | On Phone B, install **Attendly**, connect, sign in as the student | Home → today's **CS-101** |
| 16 | Try signing in to the *student* app with the teacher's email | "This is the student app. Staff accounts sign in with the Attendly Institute app." Nothing is bound |
| 17 | Phone A: open CS-101 → **QR** → **Start class & show QR** | Full-screen QR, changing every 7 s, "0 / N present" |
| 18 | Laptop: open `https://<server>/present` | A big 8-character code, e.g. `KXF7-M2QD`, with a 5-minute countdown |
| 19 | Phone A: **Show on a big screen** → type the code → **Find** | "Chrome on Windows · from 49.x.x.x · asked 10 s ago" |
| 20 | **Approve & show QR** | Laptop switches to the rotating QR + live count |
| 21 | Phone B: **Scan** → point anywhere near the laptop screen (the code can be anywhere in view; tap to focus; try **2×**) | A cyan box locks onto the code → **Marked present · ed25519 ✓ verified** |
| 22 | Look at the laptop and Phone A | "1 / N present" on both |
| 23 | Phone B: scan a random product QR | "That's not an Attendly session code." — nothing sent |
| 24 | Phone A: **Register** → tick another student | Yellow **Manual attendance** warning; **Save** stays disabled until you tick **"I have checked every name"** |
| 25 | Tick it → **Save register** | "2 / N present"; that student's entry says "Register · <teacher>" |
| 26 | Untick a student who **scanned** | A note becomes required ("why are you removing a scanned mark?") |
| 27 | **End class** | Laptop: "Class ended" (the code is dead everywhere) |

## Part 3 · No internet

| # | Do this | You should see |
|---|---|---|
| 28 | Phone A: **Add an extra class** (course, now, LH-101) → back to **Today** → wait for "Ready offline · …" | The new class is listed |
| 29 | Phone A: **airplane mode** → open the class → **Start class & show QR** | The QR still rotates; "No internet — the code still works"; Today shows "1 saved offline" |
| 30 | Phone B: **airplane mode** → Home → **Scan** the teacher's phone | **Saved offline** — "uploads by itself" |
| 31 | Phone B: Home | "1 saved offline · will upload automatically" |
| 32 | Turn airplane mode **off** on both phones (open the apps) | Phone B: "marked present"; Phone A: "class start synced". The class shows "1 / N present" |
| 33 | Phone A: in airplane mode, take a **register** for a class → **Save on phone** → back online | "register saved · X present" appears under recent uploads |

## Part 4 · What students see

| # | Do this | You should see |
|---|---|---|
| 34 | Phone B: **Subjects** → tap CS-101 | %, "You can miss N classes…", **Plan ahead** (change "Upcoming classes" / "I will attend" and the % updates), full history with how each mark was made |
| 35 | **Timetable** tab | The weekly slot on its day, and the next 7 days with status |
| 36 | **Profile → Request device reset** | "Reset requested … waiting for your admin" |

## Part 5 · Admin follow-ups

| # | Do this | You should see |
|---|---|---|
| 37 | Phone A (admin): **More → Phone requests** → **Approve** | The student's old phone stops working and they bind the new one at next sign-in |
| 38 | **Classes → CS-101 → CSV** | The share sheet with `CS-101-attendance-<date>.csv` (roll no., name, attended, held, %, standing) |
| 39 | **More → People → Students →** a student → **Suspend account** | They're signed out everywhere; **Reactivate** restores them |
| 40 | **More → Suspicious scans** | Refused scans that look like cheating (mock GPS, wrong phone), with Accept / Block / Dismiss |

## Part 6 · Changing the timetable, and the students hear about it

| # | Do this | You should see |
|---|---|---|
| 41 | Phone A (admin): **More → Batches → New** → name `CSE-2A` → add students (pick or paste roll numbers) → tick **CS-101** → **Save** | The batch; its students are now enrolled in CS-101 (Classes → CS-101 → Students) |
| 42 | Remove a student from the batch | They leave CS-101 too (unless they were enrolled directly) |
| 43 | **Timetable → Who's busy** → today | Each teacher and room with their classes on a timeline; "Free at" filters |
| 44 | Phone A (teacher): open an upcoming class → **Move** → a new time → **Confirm & notify** | "Done · N people notified" |
| 45 | Phone B (student) | Within seconds while open (or ≤ 15 min while closed): a **system notification with sound**; the bell shows 1; the class says "Moved from …" |
| 46 | Phone A: **Move** a class onto a time when the same teacher already teaches | Refused, with the clash in words |
| 47 | Phone A: **Substitute** → pick a teacher marked "Free at this time" | The substitute now sees the class on their Today; students see "Taken by …" |
| 48 | Phone A: **Cancel** → reason "Faculty meeting" | Students: "Cancelled — Faculty meeting"; it doesn't count against their % |
| 49 | Admin: **Timetable → Planner** → long-press a class → drag it to another day → drop | It moves; the draft shows 1 change and a green **Saved** badge |
| 50 | Drag a class onto another class | They swap |
| 51 | Drag a course from the tray into an empty time | An extra class appears (dashed) |
| 52 | Drag a class onto a time where its room is taken | Red outline; **Publish** is blocked until you fix it |
| 53 | **Review & publish** → **Publish** | **Published**: "1 change is live. N people were notified"; Phone B's timetable shows every change |
| 54 | Phone B: tap the bell → **Mark all read** | The count clears |

## Troubleshooting

| Problem | Fix |
|---|---|
| "Set a screen lock first" in the Institute app | Add a PIN/pattern in the phone's Settings → Security. Staff data never opens on an unlocked phone |
| "Couldn't reach that address" | Open `<server>/v1/meta` in a browser. On Render's free plan wait a minute (it was asleep) and retry |
| No code on the codes page | Wait 30 s between requests for the same email; check the email is exactly the one the admin added |
| E-GEO "Outside geofence" | The room location was saved far from where you are. Rooms → the room → **Update to my location** while standing in it, or choose "This phone, now" when starting the class |
| "Class not started yet" on the student phone | The teacher's phone started the class offline. The student's scan is saved and submits itself once the teacher's phone is online |
| No sound on notifications | The phone is on silent/Do not disturb, or "Class changes" was turned down in Settings → Apps → Attendly → Notifications |
| Notifications only arrive when the app opens | The phone's battery saver stops background checks. Settings → Apps → Attendly → Battery → Unrestricted. (Instant push when the app is fully closed needs Firebase, see HANDOFF.md) |
| Planner: "… changed this draft at the same time" | Another admin saved the same draft. Their version is loaded; redo your last move |
| Big screen: "No screen is waiting with that code" | Codes last 5 minutes and work once: reload `/present` for a new one |

---

### Verified automatically before every release

- **146 automated tests**: protocol crypto, maths and the planner engine (41); the server against real PostgreSQL (82: roles, scoping, uniqueness, replays, tampering, offline sync, registers, timetable, big-screen pairing, batches, adjustments, drafts/publish, notifications); the signed API client (15); the import parser and planner layout (8).
- **A 29-step two-app browser run** (`e2e/`) of Parts 1–4 and 6 against a production-mode server. It includes both apps offline, and QR codes decoded from the *pixels* of the laptop and teacher screens.
