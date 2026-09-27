# Two-app browser rehearsal (29 steps)

Drives the **web builds** of both apps against a **production-mode server** with an empty database:
admin onboarding → teacher QR class + big screen + register → both phones offline → reports →
drag-and-drop planner publish → student notified. QR codes are decoded from screen *pixels*.

```bash
# once
cd e2e && npm install            # jsqr + pngjs; Playwright comes from the machine (NODE_PATH)
# keys for the throwaway server: "<signing b64> <pepper b64> <dev-token hex>" in /tmp/e2ekeys, token in /tmp/devtoken
node -e "const c=require('crypto');console.log(c.randomBytes(32).toString('base64')+' '+c.randomBytes(32).toString('base64')+' '+c.randomBytes(24).toString('hex'))" > /tmp/e2ekeys
awk '{print $3}' /tmp/e2ekeys > /tmp/devtoken

# each run
npm run build -w server
(cd apps/institute && EXPO_PUBLIC_ALLOW_HTTP=1 npx expo export --platform web --output-dir /tmp/web-institute)
(cd apps/student   && EXPO_PUBLIC_ALLOW_HTTP=1 npx expo export --platform web --output-dir /tmp/web-student)
bash e2e/reset-server.sh          # fresh DB "attendly_e2e", server on :10000, static apps on :8081/:8082
NODE_PATH=$(npm root -g) OUT=/tmp/shots node e2e/both.cjs
```

Needs PostgreSQL on localhost (user `postgres`) and Chromium at `/opt/pw-browsers/chromium-1194` (edit `executablePath` otherwise).
Screenshots of every step land in `$OUT`.

## Demo-mode rehearsal (current): `cover.cjs`

10 steps against a **demo-mode** server (one-tap demo accounts):
1. Built-in server connection and one-tap sign-in.
2. The admin opens the cover board.
3. A busy teacher is refused.
4. A free teacher is dragged onto a class, with notes.
5. The teacher accepts from Today.
6. A teacher can't hand classes out.
7. The admin is told.
8. The student gets the change with the note and asks their teacher.
9. The developer console (sandbox) works.
10. The developer app refuses a student.

```bash
export EXPO_PUBLIC_ALLOW_HTTP=1 EXPO_PUBLIC_API_URL=http://localhost:10000   # web builds point at the local server
# build the three web exports to /tmp/web-{institute,student,developer}, then start a production-mode server with
# OTP_DELIVERY=console (demo mode on) and CORS for :8081–8083, and `node static.cjs`
NODE_PATH=$(npm root -g) OUT=/tmp/shots-cover node e2e/cover.cjs     # must end with ERRORS: []
```

`both.cjs` (the older 29-step run) types a server address and codes; with the built-in server and demo mode it needs
`DEMO_INSTANT_LOGIN=false` on the server and web builds without `EXPO_PUBLIC_API_URL` pointing elsewhere.

## `reports.cjs` (6 steps) and `batches.cjs` (7 steps)

Same demo-mode server as `cover.cjs` (reset it between runs; needs `fflate` from the repo root: `NODE_PATH=$(npm root -g):$PWD/node_modules`).
- **reports.cjs**: a non-admin teacher opens Attendance reports, filters by batch and subject, downloads Excel (checked as a real workbook ending with the credit line) and PDF (the printed HTML is captured), opens any student and a subject's class list; a student downloads their own report, then again **offline** from the copy on the phone.
- **batches.cjs**: a professor creates a batch (department + semester), adds a registered student, pastes a list (one new, one already registered), creates a subject inside the batch, moves the batch up a semester; a second professor can open it but gets no remove/rename/semester controls.

## `bigscreen.cjs` (6 steps) and `roles.cjs` (4 steps)

Same demo-mode server (reset between runs).
- **bigscreen.cjs**: a live CS-301 class (started via /dev); a "classroom PC" tab opens `/tv`; its **pairing QR is decoded from the screen's pixels** and must equal the code shown; the teacher pairs and approves in the Institute app; the PC's rotating class QR is decoded from pixels and a student is marked present with it; the PC's count goes to 1; ending the class blanks the PC.
- **roles.cjs**: a plain professor has no planner/cover (and sees the institution code in More); the admin grants "Planner & cover" in People & roles; the professor gets the planner and the cover board; the admin takes it back.
