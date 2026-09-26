# How Attendly works — from a new institution to a marked student

This page explains, in plain language, how data gets into Attendly and why it can't be duplicated, forged or lost.

There are **two apps** and **one server**:

| App | Who uses it | What they do |
|---|---|---|
| **Attendly Institute** | Admins and teachers | Set up the institution, run classes (QR or paper-style register), put the QR on a big screen, review problems |
| **Attendly** (student) | Students | Scan the class QR and see their attendance, timetable and what they need to stay above the minimum |
| **Server** (Render + Supabase) | — | The only source of truth. Every app talks only to it, over signed requests |

---

## 1. Onboarding an institution (done once, in this order)

The server starts **empty**, apart from the accounts you name when deploying it:

- `BOOTSTRAP_INSTITUTION_NAME` and `BOOTSTRAP_ADMIN_EMAIL` → the institution and its first **admin**
- optional `BOOTSTRAP_DEMO_TEACHER_EMAIL` / `BOOTSTRAP_DEMO_STUDENT_EMAIL` → one demo teacher and one demo student, so you can try every role right away

The admin signs in to **Attendly Institute** and follows the **Setup checklist** (Today → "Finish setting up"):

| # | Step | Why it comes here |
|---|---|---|
| 1 | **Institution settings**: name, time zone, term start, minimum % | Every class time and every percentage is calculated from these |
| 2 | **Rooms**: stand in each room and tap "Use my location" | QR classes only accept scans from inside the room's circle |
| 3 | **Teachers**: name + email (optional if the admin teaches) | Each teacher signs in with their own account and phone |
| 4 | **Courses**: code (e.g. CS-101), title, teacher, usual method (QR or register) | A course belongs to one teacher, who can only see their own courses |
| 5 | **Students**: paste a list from Excel or Google Sheets (name, roll no., email, phone…) | Hundreds at once. A header row is used if present; bad rows are listed, never guessed |
| 6 | **Enrol students in courses** (while importing, or from the course's "Students" button) | Only enrolled students can scan or be ticked |
| 7 | **Timetable**: weekly slots (day, time, room, QR/register) | Each slot creates the real classes 14 days ahead, in every app automatically |
| 8 | *(optional)* **Batches**: e.g. "CSE 2nd year · A" with its students and courses | Students added to a batch are enrolled in all its courses automatically, and leave them when removed |

Nothing else is needed: teachers and students sign in with their email and a one-time code, and bind their phone the first time.

## 2. A normal day

1. **The timetable produces today's classes.** Teachers see them on their *Today* screen; students see them on *Home* and *Timetable*.
2. **The teacher starts the class** (or taps ▶ in the middle of the tab bar):
   - **QR mode**: the phone shows a code that changes every few seconds. Tap **Show on a big screen** to put it on the classroom laptop or smartboard (see §5).
   - **Register mode**: the teacher ticks names. A yellow warning makes clear this is manual, and "I have checked every name" must be ticked before saving.
3. **Students scan.** The scanner finds the code anywhere in the camera view (you don't have to line it up in the box), refocuses by itself, and zooms (pinch, or 2× / 4×) for a projector at the back of the room. The server checks, in order:
   the code is genuine (HMAC) and current → the class is running → the student is enrolled → the phone is the student's bound phone → the location is real, recent, precise and inside the room.
4. **Instant feedback.** The student sees "Marked present" with a server signature their phone verifies. The teacher's count goes up live.
5. **Mistakes are fixable, and traceable.** The teacher can add someone who couldn't scan, or remove a mark with a written reason. Every change records who made it and when, in a tamper-evident log. Teachers can correct registers for 14 days; admins can correct any time.
6. **End class.** The QR stops working everywhere, including on the big screen.

Students always see: their % per subject, how many classes they can miss, how many they must attend in a row to get back above the minimum, a **"Plan ahead"** calculator ("if I attend x of the next y…"), their full history (present / absent / cancelled, and how each mark was made), and the weekly timetable.

## 3. No internet? Nothing is lost

| Who is offline | What happens |
|---|---|
| **Student** | The scan (code + location + the exact time) is sealed on the phone and shows "Saved offline". It uploads by itself when the phone is back online. The server judges it against the moment it was scanned, not when it arrived (accepted up to 24 h later). |
| **Teacher** | Today's and tomorrow's classes, class lists and QR keys are downloaded in advance ("Ready offline" on Today). The QR keeps rotating with no internet; starting, ending and registers taken offline are saved and uploaded later. |
| **Both** | Every screen opens from an encrypted copy on the phone, with "Offline · 5m old" shown on it. |

Every queued action carries a one-time ID, so uploading it twice (a flaky connection) can never double-count. If the server refuses something (e.g. the class was cancelled meanwhile), the app shows it under "couldn't be uploaded" with **Retry** and **Discard**, instead of silently dropping it.

## 4. How each record stays unique

These rules are enforced by the **database itself**, not just the apps, so no bug or race can break them:

| Rule | Enforced by |
|---|---|
| An email, or a phone number, belongs to exactly one person | unique index on `users.email` / `users.phone` |
| Roll numbers are unique within an institution | unique (institution, roll no.) |
| Course codes and room names are unique within an institution | unique (institution, code) / (institution, name) |
| One active phone per person, and one person per phone key | partial unique indexes on `devices` |
| One attendance record per student per class (scanning twice changes nothing) | unique (class, student) |
| One class per timetable slot per date (saving the timetable twice creates nothing twice) | unique (slot, start time) |
| An offline action is applied at most once | unique (person, one-time ID) in `client_actions` |
| A room can't be double-booked, and a teacher can't be in two places at once | checked when saving a timetable slot |
| One pending phone-switch request per person | unique index |
| A request can't be replayed | the device's nonce is stored and refused a second time |

Every institution's data is isolated. Every query is scoped to the signed-in person's institution, and teachers only reach their own courses (anything else answers "not found").

## 5. The big screen (like "log in with your phone")

Showing a QR on a phone to 60 students doesn't work, so a teacher can put it on any laptop, projector PC or smartboard **without signing in on that computer**:

1. On the computer, open **`https://<your-server>/present`**. It shows a code like `KXF7-M2QD`, valid for 5 minutes.
2. In the Institute app's live class, tap **Show on a big screen** and type the code.
3. The app shows which browser asked ("Chrome on Windows · from 49.36.x.x · asked 20 s ago"). Tap **Approve** only if that's the screen in front of you.
4. The computer shows the rotating QR and the live present count. It never receives the class's secret key; the server hands it the current picture every second, and only while the class is live.
5. **Disconnect** in the app, or **End class**, blanks the screen immediately.

Codes are single-use, stored only as keyed hashes, and rate-limited. Every approval and disconnect is written to the audit log.

## 6. Changing the timetable (adjustments) — and telling students

Classes move. Attendly makes every change **checked, published and announced**.

**One class, right now (teacher or admin)**: open the class → **Move** (new date, time, room), **Substitute** (another teacher takes it; the list shows who is *free* and who is *busy where*) or **Cancel** (a reason is required and students see it). The change is refused if it creates a clash: the same teacher, room or course twice at once. If it only overlaps another class some of the same students attend, you get a warning and can **Confirm anyway**.

**Many changes at once (admin): the Planner** (Timetable → Planner):

1. Pick a week. Every class of every batch and course is on one board, one column per day.
2. **Long-press and drag** a class to any day and time. Drop it on another class to **swap** them. Drag a course from the tray to add an **extra class**. Tap a class to change its room or teacher, or cancel it. Filter the board by batch, teacher or room.
3. Everything goes into a **draft**, saved on the server (and on the phone, if offline). Clashes are outlined in red as you drag; nothing is visible to students yet. Two admins editing the same draft can't overwrite each other: the second save is refused and reloaded.
4. **Review & publish**: a list of every change in words ("CS-101 Tue 10:00 → Wed 14:00, LH-101"), plus any clash. Publishing applies everything in **one transaction**: all of it or nothing.
5. You can also change the **weekly pattern** there ("from next week on, every Monday…"), not only one week.

**Who's busy** (Timetable → Who's busy): for any day, each teacher's and each room's classes on a timeline, and a "free at 11:00" filter. It's the view for finding a substitute.

**Students are notified** after every published change: moved, cancelled (with the reason), substitute teacher, extra class, weekly slot changed. Each affected person gets **one** grouped notification, never a flood:

- **In the app**: a bell with an unread count and a list; each class in Home, Timetable and the subject page shows "Moved from Tue 10:00", "Cancelled — faculty meeting", "Taken by Dr. Rao" or "Extra class".
- **On the phone**: a real system notification with the phone's **default sound**, vibration and lock-screen visibility, on a high-importance channel ("Class changes"). It shows while the app is open, and from a background check about every 15 minutes when it's closed. The background check uses only the phone's key and is read-only, so it can never sign anyone out.

Teachers can change only **their own** classes. Admins can change any class and the weekly pattern. Every publish is written to the audit log.

## 7. Permissions — asked once, explained honestly

The first time each app opens after sign-in, it shows a **Permissions** screen with one card per permission, saying why it's needed:

| App | Permission | Without it |
|---|---|---|
| Attendly | **Camera** | Can't scan the class QR, so the teacher must mark you by hand |
| Attendly | **Location** (while using the app) | Scans are refused: the server has to see you're in the room |
| Both | **Notifications** | You won't hear about moved, cancelled or extra classes until you open the app |
| Institute | **Location** | Can't save a room's position or start a class "from this phone" |

Tap **Allow** on each card or **Allow all**. If someone refuses, the app tells them once what will stop working, and that they can change it later in **Settings → Apps → Attendly → Permissions** (the **Open settings** button goes there). The screen can always be reopened from **Profile → Permissions** (student) or **More → Permissions** (institute).

## 8. Security in one screen

- **One person, one phone.** Each phone makes its own signing key, which never leaves it. Switching phones needs an admin's approval, and nobody can approve their own request.
- **Every request is signed** (method, path, time, random nonce, body hash), so a stolen login token is useless without the phone.
- **The QR can't be forged and goes stale in seconds.** A photo sent to a friend stops working almost immediately, and the location check stops remote scans anyway.
- **Signed receipts.** The server signs every mark and the phone checks the signature against the server key it pinned on first connect.
- **Staff phones** must have a screen lock. The Institute app asks for fingerprint, face or PIN on launch and after 30 s away, hides its content in the app switcher and blocks screenshots.
- **At rest:** codes and tokens are stored only as hashes, and everything saved on a phone is encrypted (XChaCha20-Poly1305) with a key held in the phone's secure hardware.
- **Tamper-evident history.** Every sign-in, mark, change, approval and refusal is chained with SHA-256, and the database refuses edits and deletes on it.
