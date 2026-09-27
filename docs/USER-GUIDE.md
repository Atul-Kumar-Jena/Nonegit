# Attendly — how to install, demo, beta-test and use everything

Three phone apps talk to one server (`https://attendly-api-bt9r.onrender.com`, built into the apps):

| App | Icon | Who |
|---|---|---|
| **Attendly** | black tile, white squares + dot | Students |
| **Attendly Institute** | white tile, black squares + building | Admins (principal / HOD) and professors |
| **Attendly Developer** | — | You (Attendly's owner): onboard and verify institutions |

The server keeps its data in your **Supabase** database (Render → Environment → `DATABASE_URL`). Every schema change is applied automatically when Render deploys; there is nothing to run by hand.

---

## 1 · Install (Android)

1. Open the zip link on the phone → download → open the zip → tap the `.apk`.
2. Allow "Install unknown apps" for your browser/file manager → **Install**. If Play Protect warns "unknown developer": **More details → Install anyway** (it's a test-signed build).
3. Open the app. It connects to the server by itself (the first open after a quiet hour takes up to a minute: the free server wakes up).
   **Attendly Institute** first asks for the **institution code** (8 characters, e.g. `7F3A-91C2`). It shows the institution's name with **✓ Verified by Attendly** → **Continue**. This happens once per phone; **Change** on the sign-in screen picks another institution.
4. After signing in, a **Permissions** screen asks for camera (student), location and notifications → **Allow all**. You can change them later in Settings → Apps → Attendly → Permissions.

## 2 · Demo test (dummy accounts, no codes)

The server contains a ready-made **Demo Institute of Technology** (code **DEMO-2026**) with a timetable, two Semester-6 batches and 3 months of attendance.
- **Attendly Institute:** on "Your institution" tap **Try the demo · DEMO-2026** → **Continue**.
- **Both apps:** on the sign-in screen scroll to **Demo accounts** and tap one (no code needed) → **Bind this device**.

| Tap this | Role | Use it for |
|---|---|---|
| **Dr. N. Iyer** | Admin (HOD) + teaches CS-301 | Cover classes, planner, people & roles, everything |
| **Dr. S. Banerjee** · **Dr. R. Khanna** · **Prof. A. Joshi** | Professors | Accept cover requests, run classes, batches, reports |
| **Aarav Reddy** (and 10 more) | Students | Scan, timetable, "Ask" a teacher |

(Typing the email works too, e.g. `aarav@demo.attendly.app`.)

**One phone, one student** (demo accounts included):
- A student's account is tied to the physical phone (its hardware ID), not just to the app.
- Clearing the app's data or reinstalling on the same phone signs the same student straight back in.
- A second student can't register that phone; the admin must unbind it first (People → the person → Unbind this phone).
- Moving to a different phone needs the admin's approval.
- Teachers and admins may share a phone.

**A 10-minute tour with two phones** (Phone A = Institute app, Phone B = Attendly app):

1. **A:** tap *Dr. N. Iyer* → Today → **Cover a class**.
2. Pick a day with classes (e.g. Monday). Teachers show *Free* (green) or their class (amber).
3. **Long-press** *Dr. S. Banerjee* and drop them on **CS-301** (the card turns green = free). Or tap the teacher, then the class.
4. Write a note to the teacher and one to the students → **Send request**.
5. **A:** More → sign out, tap *Dr. S. Banerjee* → Today shows the request with your note → type a reply → **Accept**.
6. **B:** tap *Aarav Reddy* → a notification arrives (bell); tap it → the class shows "Taken by Dr. S. Banerjee — your note".
7. **B:** Timetable → **Ask** on any class → "Please move this class" + a message → Send. **A** (as the class's teacher) sees it in **Requests** and answers.
8. Try dragging a teacher onto a class at a time they already teach: it's refused with the reason.
9. Teachers can't hand classes out: the cover board and "Give to a teacher" are admin-only.
10. **Batches:** sign in as *Dr. S. Banerjee* → **Classes** (opens on Batches, grouped by semester) → **New batch** → name `MATH-3A`, semester 3 → **Add students** (search "Aarav") → **Paste a list** → **Subjects → Add a subject → New subject** → **Settings → Move up to Semester 4**.
11. **Reports:** More → **Attendance reports** → pick *CSE-6A* → a subject → **PDF** / **Excel**. Tap a student to see every subject and every class. On **B** (Aarav): Profile → **Download attendance**.
12. **Roles:** as *Dr. N. Iyer* → More → **People & roles** → Professors → *Dr. S. Banerjee* → **Role & permissions** → tick **Planner & cover** → Save. Banerjee gets a notification, and More now shows *Cover a class* and *Planner*. Untick it to take it back.
13. **Big screen:** see "Big screen" below — open `attendly-api-bt9r.onrender.com/tv` on a laptop.
14. **Notices:** as *Aarav* → Home → *Notices* → open *Welcome to the Spring Term* → react 🎉. As *Dr. S. Banerjee* → More → **Notice centre → New notice** → CSE-6A → write with the toolbar → **Preview** → **Send**; Aarav gets a notification.

## 3 · Beta test (your own institution, new accounts)

Your real institution is the one you named in Render (`BOOTSTRAP_INSTITUTION_NAME`), with you as admin (`BOOTSTRAP_ADMIN_EMAIL`). It is already verified.

**Its institution code** (staff type it once in Attendly Institute) is shown in any of these places:
- Render → your service → **Logs**: the line `institution code for "…": XXXX-XXXX` (printed at every start).
- The `/dev` page (below), under **Institution codes**.
- The Developer app → Institutions → your institution.
- Institute app → **More** (under your name; tap it to share it on WhatsApp).

**Onboarding another institution** (Developer app, signed in with `BOOTSTRAP_DEVELOPER_EMAIL`):
1. Institutions → **+** → name, first admin's name and email → **Create**. It starts *Pending verification*: nobody can sign in yet.
2. Check it's genuine → **Verify institution** (✓ Verified). **Remove verification** blocks new sign-ins again; **New** gives it a fresh code if the old one leaked.
3. **Share** the code with their admin. They install Attendly Institute, enter the code, and sign in with the admin email you typed.

**Sign-in codes for real accounts** (until email is set up):
- Open `https://attendly-api-bt9r.onrender.com/dev?token=<DEV_TOOLS_TOKEN>` on a laptop (the token is in Render → Environment). Codes appear there a second after someone taps "Send OTP".
- Or switch to **Google Authenticator** (below): no codes to fetch at all.

**Steps**
1. Institute app → enter your **institution code** → **Continue** → type your admin email → **Send OTP** → type the code from the /dev page → **Bind this device**.
2. Today → **Finish setting up**:
   1. institution settings (time zone, term, minimum %);
   2. **Rooms**: stand in each room → *Use my location*;
   3. **Teachers**;
   4. **Courses**;
   5. **Students**: paste from Excel/Sheets;
   6. **Batches**, optional;
   7. **Timetable** slots.
3. Build the hierarchy: **Classes → New batch** (e.g. `CSE-5A`, department, semester) → **Paste a list** of its students → **Subjects → Add a subject**. Professors can do this themselves for their own sections.
4. For each teacher/student: **More → People → the person → Authenticator → Set up authenticator**, then show them the QR. They scan it in Google Authenticator (**+ → Scan a QR code**) and from then on sign in with *email + the app's 6-digit code*.
5. Anyone can also set it up themselves: *More / Profile → Sign-in security → Set up Google Authenticator → Open in Google Authenticator → type the first code*.
6. Run a class (below) with 2–3 real students; check **More → Attendance reports**.

## 4 · Everyday use

### Admin (principal / HOD) — Institute app
- **Today**: your classes, requests waiting for you, *Coming up*.
- **More → All features**: every screen in one box. The ⓘ on each screen explains it.
- **Cover a class**: drag a free teacher onto a class. They accept, then the students are told. You're notified of the answer.
- **Planner**: long-press a class and drag it.
  - The slot under your finger turns **green** (free, with the new time), **amber** (drop to swap) or **red** (clash, with the reason). The phone ticks at each step.
  - The red line is "now". 🔍 zooms out to the whole week.
  - Add extra classes from the tray; tap a class to change its teacher or room, or cancel it.
  - Everything stays a draft until **Review & publish**. Giving a class to another teacher sends them a request first.
- **Who's busy**: every teacher/room hour by hour, with "Free at".
- **People · Batches · Rooms · Phone requests · Suspicious scans · Institution**.

**Screenshots** are allowed by default so you can capture bugs. Turn on **More → This phone → Block screenshots** to block them and hide the app in the recent-apps view.

### Batches (everyone on staff) — Institute app
Everything is organised as **Semester → batch → its students → its subjects** (Classes tab → Batches).
- **Any professor** can create a batch (name, department, semester), add students (search registered ones, or **Paste a list** from Excel — already-registered students are just added, new ones are created) and add subjects (an existing one, or a **new subject** they will teach).
- Students in a batch get its **semester** and are enrolled in **all its subjects** automatically, including students added later.
- **Removing** students/subjects, **renaming**, **archiving** and **Move up to Semester N** (moves every student) are for admins and the professor who created the batch.
- Tap a student to see their attendance in every subject; **Attendance** opens the batch's report.

### Attendance reports & downloads
- **Staff:** More → **Attendance reports** → pick a batch (or all students) → a subject (or all subjects). Red = below the minimum. **PDF** or **Excel** downloads exactly that view: one subject (attended / held / % per student) or all subjects (each student's % per subject + cumulative). Tap any student → per-subject %, tap a subject → every class; download all subjects or one subject class by class. Every teacher can view any batch and any student.
- **Students:** Profile → **Download attendance** (or Subjects → Download, or inside a subject): all subjects with the cumulative total, or one subject class by class.
- Every file ends with "Attendly · Created by Atul Kumar Jena". Downloads work **offline** too: the file then uses the latest data saved on the phone and says how old it is.

### Class reminders
More / Profile → **Class reminders**: pick any of 5 / 10 / 15 / 30 min, 1 hour or a day before. They're set on the phone, so they ring on time even offline, include the room, follow every timetable change (and classes you're covering).

### Roles: admin vs professor
- **Admin (principal / HOD):** everything, including institution settings and who may do what. Badge: *Admin · Principal / HOD*.
- **Professor:** runs their own classes, manages batches, sees every attendance report. Badge: *Professor* (or *Professor · +2* with extra powers).
- An admin gives a professor extra powers: **More → People & roles → Professors → the person → Role & permissions**:
  - **People**: add or edit students and professors, paste lists, unbind phones, reset authenticators.
  - **Courses & timetable**: every course and its students, weekly slots, rooms.
  - **Planner & cover**: drag-and-drop planner, publish changes, give a class to another professor.
  - **Phones & scans**: approve phone switches, review suspicious scans.
- The same screen turns a professor into an admin (or back). The person gets a notification and sees the change at once.
- Only admins change roles; a professor with *People* can't create admins or edit an admin. An institution always keeps at least one admin.

### Notice centre (announcements)
- **Who can send:** any professor → one or more **batches**, or the **subjects** they teach. Admins (and professors given **Notices to everyone** in Role & permissions) → **everyone**, **all students** or **all faculty** too.
- **Write:** More → **Notice centre → New notice** → *Send to* (it shows "Reaches N people") → topic (📢 General, 📚 Academic, 📝 Exam, 🎉 Event, 🌴 Holiday) → title → text. The toolbar: **B** bold, *I* italic, ~~S~~ strike, heading, small heading, • list, 1. list, quote, link, divider — select words then tap. **Preview** shows exactly what people will see. Optional 📌 **Pin** (stays on top) and ⚠️ **Important** (red, "Important" in the notification) → **Send**.
- **Delivery:** everyone it's for gets a notification straight away (instant with Firebase; within seconds while the app is open); tapping it opens the notice. Home shows the newest unread ones.
- **Read & react:** open a notice → react with 👍 ❤️ 🎉 😂 😮 🙏 (tap again to take it back). The author (and admins) see **Seen by N of M**, and can **Edit** or **Delete** it.
- Students: Home → *Notices*, or Profile → **Notice centre**. Filters: All · Unread · Pinned, and by topic; **✓✓** marks everything read.

### Big screen (projector / smartboard / laptop)
1. On the classroom computer open **`attendly-api-bt9r.onrender.com/tv`** in any browser (or in the app: class → **Show on a big screen → Send the link**). It shows a **pairing QR** and a code like `KXF7-M2QD`.
2. In Attendly Institute: open the live class → **Show on a big screen** → **Scan the screen** and point the phone at the pairing QR (or type the code) → check it says your screen (e.g. "Chrome on Windows") → **Approve & show QR**.
3. The screen shows the big rotating QR, the class, a countdown ring and **present / enrolled**, updating live. It stays awake; press **F** for full screen. If the Wi-Fi drops it says "Reconnecting…" and carries on.
4. **End class** (or Disconnect in the app) blanks the screen. A photo of the QR is useless: it changes every few seconds and needs the student's bound phone, inside the room.

### Professor — Institute app
- Tap a class → **QR** (the code rotates every few seconds), **Show on a big screen**, or **Register**.
- **Register**: "Tap who's absent" (everyone starts present) or "Tap who's present". Tick *I have checked every name* → Save. Works offline.
- **Move / Cancel** your own class (with a note to students). **Requests**: accept/decline classes you're asked to take; answer students.

### Student — Attendly app
- **Scan** (centre button) inside the room. The camera finds the code anywhere in view (tap to focus, 2×/4× zoom). It works offline and uploads later.
- **Home**: term %, today, *Coming up*. **Subjects**: % per course, "you can miss N", plan-ahead. **Timetable**: every change with its note; **Ask** a teacher.
- **Profile → All features**: requests, notifications, sign-in security, permissions, phone reset.

## 5 · Notifications

- In the app: a change appears within **15 seconds**; tapping it opens that class.
- App closed: phones check about every 15 minutes (Android's limit), **unless Firebase is set up**. Then notifications arrive **instantly**, with the default sound, even when the app is closed. To switch that on (about 10 minutes, free):
  1. <https://console.firebase.google.com> → **Add project** (e.g. "attendly").
  2. **Add app → Android** twice: package `app.attendly.student`, then `app.attendly.institute`.
  3. **Project settings → General → your apps → download `google-services.json`** (one file covers both apps).
  4. GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**: name `GOOGLE_SERVICES_JSON`, value = the whole file's text.
  5. Firebase **Project settings → Service accounts → Generate new private key** (a JSON file).
  6. Render → your service → **Environment → Add** `FCM_SERVICE_ACCOUNT` = the whole JSON text → Save (Render redeploys).
  7. Push any commit (or re-run the latest GitHub Action) and install the new APKs. The server log then says "instant push on".
  Never paste these files into a chat.

## 6 · Supabase — what you need to do

Nothing more. Your database password lives only in Render's `DATABASE_URL`, and the server applies migrations on every deploy. To look at the data: Supabase → **Table Editor** (tables `users`, `class_sessions`, `attendance_records`, `change_requests`, `notifications`, `audit_log`…). Never share the password or connection string in chats or code. If it ever leaks: Supabase → **Project settings → Database → Reset password**, then update `DATABASE_URL` in Render.

## 7 · Going live (when the beta is done)

Follow **[PRODUCTION.md](PRODUCTION.md)**: always-on server, sign-in emails (Brevo, free), demo and `/dev` off, Firebase push, your own app-signing key (+ Play Store files), Supabase backups. The Developer app's **Production checklist** shows what's left.

## 8 · Troubleshooting

| Problem | Fix |
|---|---|
| "No institution has that code" | Check the 8 characters with your admin (letters and digits; the dash is optional). |
| "Waiting for verification by Attendly" | The developer hasn't verified the institution yet (Developer app → the institution → Verify). |
| A professor can't see Planner / People | An admin grants it: People & roles → the professor → Role & permissions. |
| "Connecting…" for a long time | The free server is waking up (≤ 1 min). "Try again" if it stops. |
| No code on the /dev page | Wait 30 s between requests for the same email; check the email is exactly the one added. |
| "Set a screen lock first" (Institute) | Add a PIN/fingerprint in phone Settings → Security. |
| Scan says "Outside geofence" | Rooms → the room → *Update to my location* while standing in it. |
| Notifications late | Tap **Get notifications on time** on Home (or Permissions → *Battery: don't optimise*) → Allow; on Xiaomi/Oppo/Vivo/Realme also allow Autostart. Set up Firebase (§5) for instant push. |
| Lost the authenticator phone | Admin: People → the person → Authenticator → **Reset** (back to emailed codes). |
| Changed phones | Student: Profile → Request device reset; admin approves in **Phone requests**. |
