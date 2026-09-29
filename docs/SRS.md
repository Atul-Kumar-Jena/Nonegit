# Attendly — Software Requirements Specification (SRS)

Version 1.0 · September 2026 · Owner: Atul Kumar Jena

This document says **what Attendly must do and must not do**. For *how* it is built, read [ARCHITECTURE.md](ARCHITECTURE.md). For every server endpoint, read [API.md](API.md).

---

## 1. Purpose and scope

Attendly is attendance that cannot be forged. It is a system for colleges and schools:

- a professor opens a class;
- students mark themselves present by scanning a rotating QR code, from inside the classroom, on their own registered phone;
- the institution gets a tamper-evident record it can trust, report on and audit.

It also covers the timetable around attendance (weekly slots, moves, cancellations, substitutes), notices, and requests between students and staff.

**In scope:** three Android apps, one API server, one PostgreSQL database.
**Out of scope today:** iOS store release, payments or billing, parent accounts, LMS or grade books.

## 2. Products

| Product | Package | Users | Purpose |
|---|---|---|---|
| **Attendly** (student app) | `app.attendly.student` | Students | Scan the class QR, see attendance per subject, timetable, notices, requests |
| **Attendly Institute** | `app.attendly.institute` | Admins and professors | Run the institution: people, courses, batches, timetable, classes, registers, reports, notices, approvals |
| **Attendly Developer** | `app.attendly.developer` | The platform owner only | Create and verify institutions, kill switches, audit log, support drill-in, broadcasts |
| **API server** | `server/` (Docker on Render) | All three apps | The single source of truth; every rule is enforced here |

## 3. User roles

| Role | Where | Can |
|---|---|---|
| **Developer** (platform owner) | Developer app | Create institutions, issue the main admin's setup code, verify institutions, flip platform switches, read the audit log, act on any person (always audited), broadcast to everyone, all students or all admins |
| **Main admin** (`is_owner`, one per institution) | Institute app | Everything an admin can, plus add, change or remove other admins. Can't be demoted until the role is handed over |
| **Admin** | Institute app | Manage the whole institution: people, courses, batches, rooms, timetable, planner, classes, reports, phone approvals, notices, flags |
| **Professor** (`teacher`) | Institute app | Run *their own* classes (QR or register), see their courses' students and reports. Plus any extra powers an admin grants: `people`, `courses`, `planner`, `devices`, `broadcast` |
| **Batch mentor** | Institute app | A professor who receives phone-switch requests from students of the batches they mentor |
| **Student** | Student app | Mark attendance, view own data, ask requests, request a phone change |
| **Demo accounts** (`@demo.attendly.app`) | All apps | Same as the matching role, in the demo institution only; one-tap sign-in while demo mode is on |

## 4. Functional requirements

Each requirement has an ID so tests, issues and commits can refer to it.

### 4.1 Onboarding and sign-in

| ID | Requirement |
|---|---|
| FR-ON-1 | Only a developer can create an institution. Creating one returns a unique **institution code** and a one-time **setup code** for the main admin. |
| FR-ON-2 | An institution must be **verified** by the developer before students and staff can use it. |
| FR-ON-3 | The Institute app asks for the institution code before sign-in. The Student app finds the institution from the student's account. |
| FR-ON-4 | Setup codes are 12 characters (`XXXX-XXXX-XXXX`), single-use, valid 7 days, and burn after 5 wrong tries. They are stored only as a keyed hash. |
| FR-ON-5 | First sign-in with a setup code links **Google Authenticator** (TOTP). Afterwards the person signs in with their ID plus the authenticator code. |
| FR-ON-6 | People without an authenticator sign in with a one-time code sent by email (or SMS where configured). Codes last 5 minutes, allow 5 tries per code and 10 failures per day per account. |
| FR-ON-7 | Demo accounts sign in with one tap only while demo mode is on. Real accounts always need a code. |
| FR-ON-8 | The developer's first-time setup code is printed in the server log and stays the same (stored encrypted) until it is used. |

### 4.2 Phones (device binding)

| ID | Requirement |
|---|---|
| FR-DV-1 | On first sign-in, each person **binds** one phone. The phone creates its own signing key, which never leaves the phone. |
| FR-DV-2 | One active phone per person, and one person per phone. This is enforced for every role except developers. |
| FR-DV-3 | Signing in on a different phone creates a **phone-switch request**. It goes to the student's batch mentor; admins (and professors with `devices`) are the backup for students without a mentor and can decide any request; the main admin can do everything. Nobody approves their own. |
| FR-DV-4 | The same physical phone with a new key (app reinstalled or data cleared) re-binds without approval. |
| FR-DV-5 | Every Android phone is recognised by its Android ID plus the app's own key, so binding works on every phone model. A build that doesn't send the Android ID is asked to update. The security-chip check (Google key attestation) is recorded and shown to staff but never blocks (only the server operator's `REQUIRE_HARDWARE_KEYS` could). |
| FR-DV-6 | Developers are never blocked by binding: the authenticator code signs them straight in, and a new phone replaces the old one. |
| FR-DV-7 | The developer can unbind any person's phone and sign them out at once, with no approval (audited). |
| FR-DV-8 | Testing switch "phone rules off": when on, nobody is stopped by phone binding. Every takeover is audited. It is off by default. |

### 4.3 Classes and attendance

| ID | Requirement |
|---|---|
| FR-CL-1 | The weekly timetable creates each day's classes automatically, 14 days ahead, one per slot per date. |
| FR-CL-2 | Every class has two logs: **class time reached** (`due_at`) and **professor arrived and started** (`started_at`). Students see "Waiting for the professor" in between. |
| FR-CL-3 | Lateness counts from 2 minutes after the scheduled start. A class never started is marked "Not held" (`missed_at`). |
| FR-CL-4 | Once started, the class is live for the whole batch. The professor chooses when to show the QR, or uses the paper-style register. |
| FR-CL-5 | The QR rotates every 5 s (default) and is `HMAC(class secret, class ‖ sequence)`. A code is valid only while it is on screen (its neighbour only within 1.5 s of the switch, for clock skew); after a class ends, scans are refused within 2 s. |
| FR-CL-6 | A scan is accepted only if every check passes, in order: the code is genuine and fresh → the class is live → the student is enrolled → it comes from the student's bound phone → the location is real, recent (under 60 s), accurate (under 75 m) and inside the room's geofence. |
| FR-CL-7 | Every refusal has a code (`E-GEO`, `E-EXPIRED`, …) with a human title and hint. Refusals are recorded, and repeated suspicious refusals are flagged to staff. |
| FR-CL-8 | One attendance record per student per class. Scanning twice changes nothing. |
| FR-CL-9 | The student gets a server-signed receipt. The phone verifies it against the server key it pinned on first connect. |
| FR-CL-10 | Offline scans are sealed on the phone and uploaded later. They are judged against the moment of scanning and accepted up to 24 h later, unless the institution refuses offline scans. |
| FR-CL-11 | The professor can add a missed student or remove a mark with a written reason. Professors can correct for 14 days, admins at any time. Every change is audited. |
| FR-CL-12 | **Big screen:** a browser at `/present` shows a pairing code. The professor approves it in the app. The screen only ever receives the current QR picture, never the class secret. |
| FR-CL-14 | A class closes itself as soon as every enrolled student is marked present (audited as `session.auto_end`); the professor sees why. |
| FR-CL-15 | **Layered scans** (fests, webinars): the professor sets 1–5 scans per class and opens each round; a student is present only after scanning in every round, and is notified when a round opens. |
| FR-CL-13 | **Attendance credit:** staff can credit a missed class (medical, fest, other) with a note. Credits count towards the percentage and can be undone. |

### 4.4 Timetable, planner and cover

| ID | Requirement |
|---|---|
| FR-TT-1 | Admins (and professors with `courses`) edit weekly slots: day, time, room, course, mode (QR or register). Sunday is allowed. |
| FR-TT-2 | A single class can be **moved**, **substituted** or **cancelled** (with a reason). Clashes (same teacher, room or course at once) are errors. Shared-student overlaps are warnings that can be confirmed. |
| FR-TT-3 | The **planner** edits a week by drag and drop into a server-saved **draft** with a version number. A stale save gets 409. Publishing applies all changes in one transaction. |
| FR-TT-4 | Every published change notifies each affected person **once**, as a grouped notification. |
| FR-TT-5 | **Cover requests:** an admin asks a free professor to take a class, with a note. The professor accepts or declines, and students are told. |
| FR-TT-6 | **Who's free:** each professor's and room's classes on a timeline, the free window around a chosen time, and one tap to schedule a class for a free professor or in a free room. |
| FR-TT-7 | Scheduling starts from the **batch**, then one of its subjects. The form suggests rooms free for the whole time and warns when the professor is busy (with their next free time). |
| FR-TT-8 | The planner shows "Past" while dragging over a time that has gone, and refuses the drop. |

### 4.5 People, batches and courses

| ID | Requirement |
|---|---|
| FR-PE-1 | Students can be pasted in bulk from a spreadsheet. Bad rows are listed, never guessed. |
| FR-PE-2 | Email and phone are unique platform-wide. Roll numbers, course codes and room names are unique per institution. |
| FR-PE-3 | **Batches** (e.g. "CSE 2nd year · A") hold students and subjects. Adding a student to a batch enrols them in all its courses, and removing them un-enrols them. |
| FR-PE-4 | Only the main admin creates or changes admins. Admins create professors. A setup code is issued at once for new staff. |
| FR-PE-5 | Suspending a person signs them out everywhere. |

### 4.6 Notices, notifications and requests

| ID | Requirement |
|---|---|
| FR-NO-1 | The **notice centre** sends a notice to everyone, students, faculty, admins, batches or subjects, with formatting, categories, pinning, "important", emoji reactions and a "seen by N of M" count. |
| FR-NO-2 | Developer **broadcasts** go to every institution or one, to everyone, only students or only admins. They are signed "Attendly" or with the developer's name, read-only for institutions, and can be withdrawn. |
| FR-NO-3 | Every notification appears in the in-app bell and as a phone notification. With Firebase configured it arrives instantly even when the app is closed. Otherwise the app checks about every 15 minutes. |
| FR-NO-4 | Class reminders count down before a class and can be acknowledged. The server also sends every student and the professor a "starts in 5 min" push. "Send me a test notification" checks a phone end to end. |
| FR-NO-5 | Students can send **requests** ("Ask") to professors, and see and cancel them. |

### 4.7 Reports

| ID | Requirement |
|---|---|
| FR-RE-1 | Students see % per subject, "can miss N", "must attend N in a row", a plan-ahead calculator and full history. |
| FR-RE-2 | Staff export per-student and per-course reports and an institution matrix as PDF and Excel. |
| FR-RE-3 | **Professors' punctuality:** for every class, its time vs when the professor started it — on time, late (minutes), not held, cancelled — per professor, over 7/30/90 days; downloadable. Admins see everyone; a professor sees their own. |
| FR-RE-4 | Students see a heads-up on Home for subjects below the minimum (classes needed in a row) or with no margin left. |

### 4.8 Developer console

| ID | Requirement |
|---|---|
| FR-DC-1 | Console: health, counts, production checklist, recent audit entries. |
| FR-DC-2 | **Kill switches**, each enforced on the server: pause scans, pause sign-ins, reject new phone bindings, relax hardware checks, turn off demo sign-in, pause phone notifications, phone rules off (testing). Flipping one needs the switch name typed and a reason. |
| FR-DC-3 | **Sign everyone out** (one institution or all), except developers. |
| FR-DC-4 | **Support drill-in:** list and open any institution's people, and suspend, reactivate, unbind a phone, issue a setup code, or change role or main admin. People see "Attendly support" or the developer's name, but the audit log **always** records the developer's account. There is no trace-free mode. |
| FR-DC-5 | The audit hash chain can be verified from the app. |
| FR-DC-6 | The demo "sandbox developer" can create up to 20 test institutions and read the demo institution, but can't change real data or platform switches. |

## 5. Non-functional requirements

| ID | Area | Requirement |
|---|---|---|
| NFR-1 | Security | Every authenticated request is signed by the phone's key over (method, path, time, nonce, body hash). A stolen token is useless without the phone. Clock skew is limited to 90 s and nonces are single-use. |
| NFR-2 | Security | Access tokens last 15 minutes. Refresh tokens last 30 days, rotate on each use, and reusing an old one revokes the whole family. |
| NFR-3 | Integrity | The audit log is a SHA-256 hash chain, and the database refuses updates and deletes on it. |
| NFR-4 | Privacy | Every query is scoped to the caller's institution. Out-of-scope resources answer 404 so their existence never leaks. |
| NFR-5 | Data at rest | One-time codes, tokens and setup codes are stored only as keyed hashes. TOTP secrets are encrypted. On the phone, everything is encrypted with XChaCha20-Poly1305 using a key in SecureStore. |
| NFR-6 | Reliability | The server is the only source of truth, and uniqueness is enforced by database constraints. Offline actions carry one-time IDs, so a double upload never double-counts. |
| NFR-7 | Availability | Apps open from an encrypted cache with "Offline · N min old". Professors get an offline pack for today and tomorrow. |
| NFR-8 | Performance | Scan to receipt in under 1 s on a good connection. A broadcast to thousands goes out in seconds (500 per batch, 25 parallel). |
| NFR-9 | Abuse | A generous per-IP limit (3000/min, for campus NAT) plus per-device limits. Sign-in routes allow 120/min. |
| NFR-10 | Robustness | Apps must never crash. Every native call is wrapped and degrades gracefully. CI opens every APK on an emulator before publishing. |
| NFR-11 | Usability | Minimal monochrome UI, 12-hour times, no keyboard covering inputs, every button does something real. |
| NFR-12 | Compliance (India DPDP Act 2023) | Collect only what attendance needs, isolate each institution, keep an audit trail, allow correction. Breach and consent processes are listed in the Security Policy (future document). |

## 6. Must NOT do

- Never accept a scan from a phone other than the student's bound phone (except while the developer's testing switch is on).
- Never let one account's action be recorded as another's. Support actions are always recorded under the developer.
- Never store raw one-time codes, refresh tokens or setup codes.
- Never put secrets (database URL, signing keys, Firebase service account) in the repository or in a chat.
- Never let a professor see or change another professor's classes unless an admin granted it.
- Never silently drop an offline action. Refused uploads are shown with Retry and Discard.

## 7. Constraints and assumptions

- Android first (Expo SDK 57 / React Native 0.86). iOS builds but isn't released.
- Server: Node 22, Fastify 5, PostgreSQL 16 (Supabase), Docker on Render.
- Instant notifications need Firebase (FCM). Without it, apps check about every 15 minutes.
- The free Render plan sleeps after idle time, so production should use an always-on plan.

## 8. Acceptance

A requirement is done when it has a server integration test (`server/test/*.test.ts`, 240+ tests, real PostgreSQL) or a browser rehearsal (`e2e/*.cjs`), and CI is green, including the emulator check.
