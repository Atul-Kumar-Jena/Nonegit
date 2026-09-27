// End-to-end: a brand-new institution is onboarded in the Institute app, a teacher runs
// classes (QR + register, online + offline) and students scan in the Student app.
const { chromium } = require('playwright');
const fs = require('fs');
const QD = process.env.QRDEC_MODULES ?? require('path').join(__dirname, 'node_modules') + '/';
const jsQR = require(QD + 'jsqr');
const { PNG } = require(QD + 'pngjs');
/** Reads a QR code off a screen's pixels, like a phone camera would. */
const readQr = async (locator) => {
  const png = PNG.sync.read(await locator.screenshot());
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!r) throw new Error('QR not readable from screen');
  return r.data;
};
const OUT = process.env.OUT || '/tmp/shots';
fs.mkdirSync(OUT, { recursive: true });
const TOKEN = fs.readFileSync(process.env.DEVTOKEN_FILE || '/tmp/devtoken', 'utf8').trim();
const API = 'http://localhost:10000';
const HERE = { latitude: 28.6139, longitude: 77.209 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const PAGES = [];
const step = (m) => console.log(`✔ ${++n}. ${m}`);
const dev = async (p) => (await fetch(API + p, { headers: { 'x-dev-token': TOKEN } })).json();
const codesFor = async (to) => (await dev('/dev/api/codes')).filter((x) => x.to === to).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
/** Presses "Send OTP" (waiting out the resend cooldown) and returns the fresh code. */
const requestCode = async (page, to) => {
  const before = (await codesFor(to)).length;
  for (let i = 0; i < 80; i++) {
    await page.getByRole('button', { name: 'Send OTP' }).click();
    for (let j = 0; j < 12; j++) {
      const c = await codesFor(to);
      if (c.length > before) return c[c.length - 1].code;
      await sleep(250);
    }
  }
  throw new Error('no code for ' + to);
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errors = [];
  const mk = async (name, port) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, geolocation: { ...HERE, accuracy: 8 }, permissions: ['geolocation', 'camera'], acceptDownloads: true });
    await ctx.addInitScript(() => {
      window.BarcodeDetector = class { static async getSupportedFormats() { return ['qr_code']; } async detect() { return window.__qr ? [{ rawValue: window.__qr, format: 'qr_code', boundingBox: { x: 0, y: 0, width: 9, height: 9 }, cornerPoints: [] }] : []; } };
      window.confirm = () => true;
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(m.text())) errors.push(`${name} console: ${m.text().slice(0, 300)}`); });
    page.shot = async (s) => { await sleep(600); await page.screenshot({ path: `${OUT}/${name}-${s}.png` }); };
    page.ctx = ctx;
    PAGES.push([name, page]);
    return page;
  };
  const signIn = async (page, port, email, landing) => {
    await page.goto(`http://localhost:${port}/`);
    // Builds with a built-in server connect by themselves; older ones ask for the address.
    const addr = page.getByLabel('Server address');
    await Promise.race([
      addr.waitFor({ timeout: 60000 }),
      page.getByLabel('Institution code').waitFor({ timeout: 60000 }),
      page.getByText('Sign in', { exact: true }).waitFor({ timeout: 60000 }),
    ]).catch(() => {});
    if (await addr.isVisible().catch(() => false)) {
      await addr.fill(API);
      await page.getByRole('button', { name: 'Connect' }).click();
    }
    if (port === 8082) {
      // Institute app: the institution's code first (read here from the /dev tools page).
      await page.getByLabel('Institution code').waitFor({ timeout: 30000 });
      const inst = (await dev('/dev/api/institutions')).find((t) => t.name === 'Green Valley College');
      await page.getByLabel('Institution code').fill(`${inst.code.slice(0, 4)}-${inst.code.slice(4)}`.toLowerCase());
      await page.getByRole('button', { name: 'Find institution' }).click();
      await page.getByText('Verified by Attendly').waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: /^Continue to Green Valley College/ }).click();
    }
    await page.getByText('Sign in', { exact: true }).waitFor({ timeout: 30000 });
    await page.getByLabel('Institution email').fill(email);
    const code = await requestCode(page, email);
    await page.getByText('Enter the code').waitFor();
    await page.getByLabel('One-time code').click();
    await page.keyboard.type(code);
    await page.getByRole('button', { name: 'Bind this device' }).click({ timeout: 20000 });
    await page.getByText(landing).first().waitFor({ timeout: 30000 });
  };
  const backTo = async (page, text) => {
    for (let i = 0; i < 5; i++) {
      if (await page.getByText(text).first().isVisible().catch(() => false)) return;
      await page.getByRole('button', { name: /^(Back|Close)$/ }).first().click();
      await sleep(500);
    }
    await page.getByText(text).first().waitFor({ timeout: 5000 });
  };
  // Navigation ignores a second push within 350 ms (double-tap guard): pause after going back.
  const back = async (page) => {
    await page.getByRole('button', { name: 'Back' }).first().click();
    await sleep(900);
  };
  const tab = (page, name) => page.getByRole('tab', { name }).click();

  // ───────────── 1. Admin onboards the institution ─────────────
  const admin = await mk('admin', 8082);
  await signIn(admin, 8082, 'principal@greenvalley.edu', 'Finish setting up');
  await admin.shot('01-today-empty');
  step('Admin signs in to a brand-new institution → "Finish setting up" nudge');


  await admin.getByText('Finish setting up').click();
  await admin.getByText('Set up your institution').waitFor();
  await admin.shot('02-setup');
  await admin.getByText('1. Check institution settings').click();
  await sleep(900);
  await admin.getByRole('button', { name: 'Save settings' }).click();
  await admin.getByText(/Saved\. Every app/).waitFor();
  await back(admin);
  step('Institution settings saved');

  await admin.getByText('2. Add classrooms').click();
  await sleep(900);
  await admin.getByRole('button', { name: 'Add a room' }).click();
  await admin.getByPlaceholder('LH-204').fill('LH-101');
  await admin.getByRole('button', { name: 'Use my location' }).click();
  await admin.getByText(/Centre saved · measured to ±8 m/).waitFor({ timeout: 30000 });
  await admin.shot('03-room');
  await admin.getByRole('button', { name: 'Save room' }).click();
  await admin.getByText('LH-101').waitFor();
  await admin.getByText(/Location saved · ±8 m · 50 m radius/).waitFor();
  await back(admin);
  step('Room LH-101 saved with this phone’s GPS location');

  await admin.getByText('3. Add teachers').click();
  await sleep(900);
  await admin.getByRole('button', { name: 'Add', exact: true }).click();
  await admin.getByPlaceholder('As on the ID card').fill('Ravi Kumar');
  await admin.getByPlaceholder('name@college.edu').fill('ravi@greenvalley.edu');
  await admin.getByRole('button', { name: 'Add teacher' }).click();
  await admin.getByText('Not signed in').first().waitFor({ timeout: 15000 }).catch(() => {});
  await admin.getByText('No phone bound yet').waitFor({ timeout: 15000 });
  await admin.shot('04-teacher');
  await back(admin);
  await back(admin);
  step('Teacher Ravi Kumar added');

  // Wrong-app guard: the admin email is refused by the student app.
  const wrong = await mk('wrong', 8081);
  await wrong.goto('http://localhost:8081/');
  await wrong.getByLabel('Server address').fill(API);
  await wrong.getByRole('button', { name: 'Connect' }).click();
  await wrong.getByLabel('Institution email').fill('ravi@greenvalley.edu');
  const wcode = await requestCode(wrong, 'ravi@greenvalley.edu');
  await wrong.getByText('Enter the code').waitFor();
  await wrong.getByLabel('One-time code').click();
  await wrong.keyboard.type(wcode);
  await wrong.getByText(/This is the student app/).first().waitFor({ timeout: 15000 });
  await wrong.shot('wrong-app');
  step('Staff account is refused by the Student app before any phone is bound');
  await wrong.ctx.close();

  await admin.getByText('4. Create courses').click();
  await sleep(900);
  await admin.getByPlaceholder('CS-301').fill('cs-101');
  await admin.getByPlaceholder('Operating Systems').fill('Intro to Programming');
  await admin.getByRole('button', { name: 'Teacher' }).click();
  await admin.getByText('Ravi Kumar').click();
  await admin.getByRole('button', { name: 'Create course' }).click();
  await admin.getByText('No students enrolled').waitFor({ timeout: 15000 });
  await admin.shot('05-course');
  await back(admin);
  step('Course CS-101 created (code upper-cased), taught by Ravi');

  // Uniqueness: the same course code twice is refused with a clear message.
  await admin.getByText('4. Create courses').click();
  await sleep(900);
  await admin.getByPlaceholder('CS-301').fill('CS-101');
  await admin.getByPlaceholder('Operating Systems').fill('Duplicate');
  await admin.getByRole('button', { name: 'Create course' }).click();
  await admin.getByText(/already/i).first().waitFor({ timeout: 15000 });
  await admin.shot('05b-duplicate');
  await back(admin);
  step('Duplicate course code refused: ' + (await admin.getByText(/already/i).first().textContent().catch(() => 'shown')));

  await admin.getByText(/^\d\. Add students/).click();
  await admin.locator('textarea').fill('Name,Roll No,Email\nAarav Sharma,21CS001,aarav@gv.edu\nDiya Patel,21CS002,diya@gv.edu\nKabir Rao,21CS003,kabir@gv.edu\nBroken Row,21CS004,');
  await admin.getByText('3 ready · 1 need fixing').waitFor();
  await admin.getByRole('checkbox', { name: /CS-101/ }).click();
  await admin.getByRole('button', { name: /Add 3 students/ }).click();
  await admin.getByText('3 added').waitFor({ timeout: 20000 });
  await admin.shot('06-import');
  // Import the same people again → all skipped as duplicates.
  await admin.locator('textarea').fill('Aarav Sharma,21CS001,aarav@gv.edu');
  await admin.getByRole('button', { name: /Add 1 students/ }).click();
  await admin.getByText('1 skipped').waitFor({ timeout: 20000 });
  await admin.shot('06b-reimport');
  await back(admin);
  step('3 students pasted from a spreadsheet and enrolled; re-import skipped as duplicate');

  await admin.getByText(/^\d\. Build the timetable/).click();
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Kolkata' });
  await admin.getByRole('button', { name: 'Course' }).click();
  await admin.getByText('CS-101 · Intro to Programming').last().click();
  await admin.getByRole('radio', { name: today }).click();
  for (let i = 0; i < 9; i++) await admin.getByRole('button', { name: 'Earlier Start hour' }).click();
  for (let i = 0; i < 11; i++) await admin.getByRole('button', { name: 'Earlier End hour' }).click();
  for (let i = 0; i < 11; i++) await admin.getByRole('button', { name: 'Later End minutes' }).click();
  await admin.getByRole('button', { name: 'Room' }).click();
  await admin.getByText('LH-101').last().click();
  await admin.shot('07-slot');
  await admin.getByRole('button', { name: 'Add to timetable' }).click();
  await admin.getByText('Set up your institution').waitFor({ timeout: 15000 });
  await admin.shot('08-setup-done');
  step(`Weekly slot added: every ${today} 00:00–23:55 in LH-101`);

  // A second slot for the same teacher at an overlapping time is refused.
  await admin.getByText(/^\d\. Build the timetable/).click();
  await admin.getByRole('button', { name: 'Course' }).click();
  await admin.getByText('CS-101 · Intro to Programming').last().click();
  await admin.getByRole('radio', { name: today }).click();
  await admin.getByRole('button', { name: 'Add to timetable' }).click();
  await admin.getByText(/already teaches|already booked/).waitFor({ timeout: 15000 });
  step('Overlapping slot for the same teacher refused');
  await back(admin);

  // ───────────── 2. Teacher runs a QR class ─────────────
  const teacher = await mk('teacher', 8082);
  await signIn(teacher, 8082, 'ravi@greenvalley.edu', 'CS-101 · Intro to Programming');
  await teacher.shot('10-today');
  step('Teacher signs in → today’s CS-101 class is already there (from the timetable)');

  const student = await mk('aarav', 8081);
  await signIn(student, 8081, 'aarav@gv.edu', 'Term attendance');
  await student.getByText('Intro to Programming').first().waitFor();
  await student.shot('20-home');
  step('Student Aarav signs in → sees today’s CS-101 class');

  await teacher.getByText('CS-101 · Intro to Programming').first().click();
  await teacher.getByRole('button', { name: 'Start class & show QR' }).click();
  await teacher.getByLabel('Attendance QR code').waitFor({ timeout: 20000 });
  await teacher.shot('11-live-qr');
  step('Teacher: Start class → rotating QR on screen');

  // Big screen: a classroom laptop opens /present and the teacher approves it from the app.
  const board = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  board.on('pageerror', (e) => errors.push('board pageerror: ' + e.message));
  await board.goto(`${API}/tv`); // the short address → /present
  await board.locator('#code').filter({ hasText: /^[A-Z0-9]{4}-[A-Z0-9]{4}$/ }).waitFor({ timeout: 15000 });
  const boardCode = (await board.locator('#code').textContent()).trim();
  await board.locator('#pairqr svg').waitFor({ timeout: 15000 });
  await board.screenshot({ path: `${OUT}/board-1-code.png` });
  // The pairing QR, read from the screen's pixels, is what the app's "Scan the screen" reads.
  const pairing = await readQr(board.locator('#pairqr'));
  if (pairing !== `ATTENDLY-TV:${boardCode.replace('-', '')}`) throw new Error(`pairing QR says ${pairing}, screen shows ${boardCode}`);
  await teacher.getByRole('button', { name: /Show on a big screen/ }).click();
  await teacher.getByLabel('Screen code').fill(boardCode.toLowerCase().replace('-', ''));
  await teacher.getByRole('button', { name: 'Find', exact: true }).click();
  await teacher.getByText(/Chrome on Linux/).first().waitFor({ timeout: 15000 });
  await teacher.shot('11b-approve-screen');
  await teacher.getByRole('button', { name: /Approve & show QR/ }).click();
  await teacher.getByText(/now shows the CS-101 QR/).waitFor({ timeout: 15000 });
  await board.locator('#qr svg').waitFor({ timeout: 15000 });
  await board.screenshot({ path: `${OUT}/board-2-live.png` });
  await teacher.getByRole('button', { name: 'Close' }).last().click();
  step(`Big screen: laptop opens /tv, shows ${boardCode} + a pairing QR that decodes to it → teacher pairs, sees "Chrome on Linux", approves → rotating QR on the laptop`);
  const boardToken = await readQr(board.locator('#qr'));

  await student.ctx.setGeolocation({ ...HERE, accuracy: 8 }); // a fresh GPS fix, as a phone would take
  await student.getByRole('button', { name: /Scan for/ }).first().click({ timeout: 45000 }); // dashboard refreshes every 30 s
  await student.evaluate((t) => { window.__qr = t; }, boardToken);
  await student.getByText('Marked present').waitFor({ timeout: 20000 });
  await student.getByText('ed25519 ✓ verified').waitFor();
  await student.shot('21-marked');
  step('Student scans the code on the laptop screen → "Marked present · ed25519 ✓ verified"');

  await teacher.getByText(/1\s*\/ 3 present/).waitFor({ timeout: 15000 });
  await teacher.shot('12-live-count');
  step('Teacher’s live screen counts 1 / 3 present');

  // Manual register for someone who can't scan.
  await teacher.getByRole('button', { name: 'Register' }).click();
  await teacher.getByText('Manual attendance.').waitFor();
  await teacher.getByRole('checkbox', { name: /Diya Patel/ }).click();
  const save = teacher.getByRole('button', { name: 'Save register' });
  if (await save.isEnabled()) throw new Error('Save enabled before confirming');
  await teacher.getByRole('checkbox', { name: /I have checked every name/ }).click();
  await teacher.shot('13-register');
  await save.click();
  await teacher.getByText(/2\s*\/ 3 present/).waitFor({ timeout: 15000 });
  step('Register: Diya ticked by hand (warning + "I have checked every name" required) → 2 / 3');

  await teacher.getByRole('button', { name: 'End class' }).click();
  await teacher.getByRole('button', { name: 'Correct the register' }).waitFor({ timeout: 15000 });
  await teacher.shot('14-closed');
  await board.getByText('Class ended').waitFor({ timeout: 15000 });
  await board.screenshot({ path: `${OUT}/board-3-ended.png` });
  step('Teacher ends the class → the laptop screen blanks to "Class ended"');

  // ───────────── 3. Offline: teacher and student both lose internet ─────────────
  await backTo(teacher, 'Add an extra class');
  await teacher.getByRole('button', { name: 'Add an extra class' }).click();
  await teacher.getByRole('button', { name: 'Course' }).click();
  await teacher.getByText('CS-101 · Intro to Programming').last().click();
  await teacher.getByRole('button', { name: 'Room' }).click();
  await teacher.getByText('LH-101').last().click();
  await teacher.getByRole('button', { name: 'Add class' }).click();
  await teacher.getByRole('button', { name: 'Start class & show QR' }).waitFor({ timeout: 15000 });
  await backTo(teacher, 'Add an extra class');
  await teacher.getByText(/Ready offline · [1-9]\d* class/).waitFor({ timeout: 20000 });
  const extra = (await dev('/dev/api/sessions')).length; void extra;
  await teacher.getByText('Scheduled').first().click();
  await teacher.ctx.setOffline(true);
  await teacher.getByRole('button', { name: 'Start class & show QR' }).click();
  await teacher.getByLabel('Attendance QR code').waitFor({ timeout: 20000 });
  await teacher.getByText(/No internet — the code still works/).waitFor({ timeout: 15000 });
  await teacher.shot('15-offline-qr');
  step('Teacher OFFLINE: extra class started → QR still rotating (key from the offline pack)');

  // The QR on the teacher's phone, read by the student's camera:

  await student.getByRole('button', { name: 'Back to dashboard' }).click();
  await student.getByText('Term attendance').waitFor();
  await student.getByText('15:').first().waitFor({ timeout: 45000 }).catch(() => {});
  await student.ctx.setGeolocation({ ...HERE, accuracy: 8 });
  await student.ctx.setOffline(true);
  await student.getByRole('button', { name: /Scan for/ }).first().click({ timeout: 30000 });
  // The camera sees the teacher's phone *now*:
  const offToken = await readQr(teacher.getByLabel('Attendance QR code'));
  await student.evaluate((t) => { window.__qr = t; }, offToken);
  await student.getByText(/Saved offline|Saved — waiting for class/).waitFor({ timeout: 40000 });
  await student.shot('22-saved-offline');
  step('Student OFFLINE scan → "Saved offline" (sealed on the phone)');

  await student.getByRole('button', { name: 'Back to dashboard' }).click();
  await student.getByText(/1 saved offline/).waitFor({ timeout: 15000 });
  await student.shot('23-pending');
  await student.ctx.setOffline(false);
  await teacher.ctx.setOffline(false);
  await student.getByRole('button', { name: 'Send now' }).click().catch(() => {});
  await student.getByText(/marked present/).first().waitFor({ timeout: 90000 });
  await student.shot('24-synced');
  step('Back online → student’s scan uploads automatically → "marked present · offline scan accepted"');

  await backTo(teacher, 'Add an extra class');
  await teacher.getByText(/class start synced/).waitFor({ timeout: 90000 });
  await teacher.shot('16-synced');
  step('Teacher back online → class start synced');

  // ───────────── 4. Student sees everything ─────────────
  await student.getByRole('tab', { name: 'Subjects' }).click();
  await student.getByRole('button', { name: /Intro to Programming, .*Open details/ }).click();
  await student.getByText('Plan ahead', { exact: true }).waitFor();
  await student.getByText('History', { exact: true }).waitFor();
  await student.shot('25-subject');
  step('Student opens the subject → percentage, "Plan ahead" planner, full history');
  await student.getByRole('button', { name: 'Increase I will attend' }).click().catch(() => {});
  await student.getByRole('button', { name: 'Back' }).click();
  await student.getByRole('tab', { name: 'Timetable' }).click();
  await student.getByText('Next 7 days').waitFor();
  await student.shot('26-timetable');
  step('Student timetable shows the weekly slot set by the admin');

  // ───────────── 5. Admin report ─────────────
  await backTo(admin, 'Add an extra class');
  await admin.getByRole('tab', { name: 'Classes' }).click();
  await admin.getByText('Intro to Programming').last().click();
  await admin.getByText('Aarav Sharma').last().waitFor({ timeout: 15000 });
  await admin.shot('09-report');
  const [download] = await Promise.all([admin.waitForEvent('download', { timeout: 15000 }), admin.getByRole('button', { name: 'CSV' }).click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  if (!/Aarav Sharma/.test(csv)) throw new Error('CSV missing data');
  step('Admin course report → CSV export: ' + csv.split('\r\n')[1]);

  // ───────────── 6. Timetable change: drag in the planner → publish → students notified ─────────────
  await backTo(admin, 'Add an extra class');
  await admin.getByRole('tab', { name: 'More' }).click();
  await admin.getByText('Timetable planner').click();
  await admin.getByText(/Week /).first().waitFor({ timeout: 20000 });
  await admin.getByRole('button', { name: 'Next week' }).click();
  const card = admin.getByRole('button', { name: /^CS-101 00:00 to 23:55/ }).first();
  await card.waitFor({ timeout: 20000 });
  await admin.shot('20-planner');
  const box = await card.boundingBox();
  const tue = await admin.getByText('Tue', { exact: true }).first().boundingBox();
  // Long-press, then drag the class onto Tuesday.
  await admin.mouse.move(box.x + box.width / 2, box.y + 20);
  await admin.mouse.down();
  await sleep(450);
  for (let i = 1; i <= 12; i++) await admin.mouse.move(box.x + box.width / 2 + ((tue.x + tue.width / 2) - (box.x + box.width / 2)) * (i / 12), box.y + 20 + 30 * (i / 12));
  await sleep(200);
  await admin.mouse.up();
  await admin.getByText(/^1 change/).waitFor({ timeout: 10000 });
  await admin.shot('21-dragged');
  step('Admin drags next week’s CS-101 class onto Tuesday in the planner (draft, nothing published yet)');
  await admin.getByRole('button', { name: 'Review & publish' }).click();
  await admin.getByText(/→ Tue/).first().waitFor();
  await admin.shot('22-review');
  await admin.getByRole('button', { name: /Publish (anyway )?& notify/ }).click();
  await admin.getByText(/changes? (is|are) live/).waitFor({ timeout: 20000 });
  await admin.shot('23-published');
  step('Review → Publish: ' + (await admin.getByText(/changes? (is|are) live/).textContent()));

  await student.getByRole('tab', { name: 'Home' }).click();
  // The app polls about once a minute: the bell's count goes up by itself.
  await student.getByRole('button', { name: 'Notifications, 2 unread' }).first().waitFor({ timeout: 90000 });
  await student.getByRole('button', { name: 'Notifications, 2 unread' }).first().click();
  await student.getByText(/Class moved · CS-101/).first().waitFor({ timeout: 15000 });
  await student.shot('27-notifications');
  step('Student’s bell shows the change: “Class moved · CS-101 …”');
  await student.getByText(/Class moved · CS-101/).first().click();
  await student.getByText(/Moved from/).last().waitFor({ timeout: 20000 });
  await student.shot('28-timetable-moved');
  step('Tapping it opens the timetable, where the class shows “Moved from …”');

  console.log('ERRORS:', JSON.stringify(errors, null, 1));
  await browser.close();
})().catch(async (e) => {
  console.error('✘ FAILED at step', n + 1, ':', e.message.split('\n').slice(0, 3).join(' | '));
  for (const [name, p] of PAGES) {
    try {
      await p.screenshot({ path: `${OUT}/FAIL-${name}.png` });
      console.error(`--- ${name}: ${(await p.textContent('body')).replace(/\s+/g, ' ').slice(0, 600)}`);
    } catch {}
  }
  process.exit(1);
});
