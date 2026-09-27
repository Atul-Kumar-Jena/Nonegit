/**
 * Rehearsal of the demo + cover-request + developer flows against a demo-mode server
 * (see README.md). One-tap demo sign-in, admin drags a free teacher onto a class with notes,
 * the teacher accepts, the student is notified with the note, teachers can't hand classes out,
 * and the developer console works.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const OUT = process.env.OUT || '/tmp/shots-cover';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let lastPage = null;
const INSTITUTE = 'http://localhost:8082';
const STUDENT = 'http://localhost:8081';
const DEVELOPER = 'http://localhost:8083';
const ERRORS = [];
let n = 0;
const shot = async (page, name) => (lastPage = page).screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}-${name}.png` });
const step = async (name, fn) => {
  process.stdout.write(`• ${name} … `);
  try {
    await fn();
    console.log('ok');
  } catch (err) {
    console.log('FAILED');
    if (lastPage) await lastPage.screenshot({ path: `${OUT}/FAILED-${String(++n).padStart(2, '0')}.png` }).catch(() => {});
    ERRORS.push(`${name}: ${err.message.split('\n')[0]}`);
  }
};

async function demoSignIn(browser, url, name) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 880 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  lastPage = page;
  page.on('pageerror', (e) => ERRORS.push(`${name} page error: ${e.message}`));
  await page.goto(url);
  // Institute app: the first time, the institution code (the demo institute has a one-tap button).
  const demoInst = page.getByRole('button', { name: /Try the demo/ });
  await Promise.race([demoInst.waitFor({ timeout: 60_000 }), page.getByText('Demo accounts', { exact: false }).first().waitFor({ timeout: 60_000 })]).catch(() => {});
  if (await demoInst.isVisible().catch(() => false)) {
    await demoInst.click();
    await page.getByText('Verified by Attendly').waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: /^Continue to / }).click();
  }
  await page.getByText('Demo accounts', { exact: false }).first().waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: new RegExp(`Sign in as ${name}`) }).click();
  // First time on this phone: the one-tap "Bind this device" step.
  const bind = page.getByRole('button', { name: 'Bind this device' });
  await bind.waitFor({ timeout: 30_000 });
  await bind.click();
  return { ctx, page };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  let admin, teacher, student, dev;

  await step('Institute connects to the built-in server and lists demo accounts', async () => {
    admin = await demoSignIn(browser, INSTITUTE, 'Dr. N. Iyer');
    await admin.page.getByText('Admin · Principal / HOD').waitFor({ timeout: 30_000 });
    await shot(admin.page, 'admin-today');
  });

  let dayIndex = -1;
  await step('Admin opens the cover board and finds a day with classes', async () => {
    await admin.page.getByRole('button', { name: 'Cover a class' }).click();
    await admin.page.getByText('Teachers', { exact: true }).waitFor();
    for (let i = 0; i < 7; i++) {
      await admin.page.getByRole('radio').nth(i).click();
      await admin.page.waitForTimeout(700);
      if (await admin.page.getByLabel(/CS-301 10:00/).count()) {
        dayIndex = i;
        break;
      }
    }
    if (dayIndex < 0) throw new Error('no CS-301 10:00 class in the next 7 days');
    await shot(admin.page, 'cover-board');
  });

  await step('Dragging a busy teacher onto the class is refused', async () => {
    const p = admin.page;
    // Iyer teaches CS-301 himself → "already takes this class".
    const chip = p.getByLabel(/^Dr\. N\. Iyer \(you\):/);
    const target = p.getByLabel(/CS-301 10:00/).first();
    await drag(p, chip, target);
    await p.getByText(/already takes this class/).waitFor({ timeout: 5000 });
    await shot(p, 'drag-refused');
  });

  await step('Admin drags a free teacher onto the class, adds notes, sends the request', async () => {
    const p = admin.page;
    const chip = p.getByLabel(/^Dr\. S\. Banerjee:/);
    const target = p.getByLabel(/CS-301 10:00/).first();
    await drag(p, chip, target, async () => {
      await p.getByText('Drop to ask Dr. S. Banerjee').waitFor({ timeout: 5000 });
      await shot(p, 'drag-hover-free');
    });
    await p.getByText('Cover this class').waitFor();
    await p.getByPlaceholder(/conference/).fill('I am at the NAAC review — please cover unit 3 (scheduling).');
    await p.getByPlaceholder(/lab records/).fill('Dr. Banerjee takes this class; bring your OS notebooks.');
    await shot(p, 'cover-sheet');
    await p.getByRole('button', { name: 'Send request' }).click();
    await p.getByText(/Request sent/).first().waitFor();
    await p.getByText(/Waiting for Dr\. S\. Banerjee/).waitFor({ timeout: 10_000 });
    await shot(p, 'request-sent');
  });

  await step('The teacher sees the request (with the note) on Today and accepts', async () => {
    teacher = await demoSignIn(browser, INSTITUTE, 'Dr. S. Banerjee');
    const p = teacher.page;
    await p.getByText('1 request waiting for you').waitFor({ timeout: 30_000 });
    await p.getByText(/NAAC review/).waitFor();
    await shot(p, 'teacher-banner');
    await p.getByPlaceholder(/Reply \(optional\)/).fill('Sure, covering unit 3.');
    await p.getByRole('button', { name: 'Accept' }).click();
    // The card says "Done — CS-301 is yours", then leaves Today once the list refreshes.
    await p.getByText('1 request waiting for you').waitFor({ state: 'detached', timeout: 20_000 });
    await shot(p, 'teacher-accepted');
  });

  await step('A teacher cannot hand classes out', async () => {
    const p = teacher.page;
    // (The server refuses it too — see server/test/requests.test.ts.)
    await p.getByRole('tab', { name: 'More' }).click();
    await p.getByText('All features').waitFor({ timeout: 20_000 });
    if (await p.getByText('Cover a class', { exact: true }).count()) throw new Error('cover shown to a teacher');
    await shot(p, 'teacher-role');
  });

  await step('The admin is told it was accepted', async () => {
    const p = admin.page;
    await p.getByRole('button', { name: 'Back' }).first().click();
    await p.getByRole('button', { name: /^Notifications/ }).first().click();
    await p.getByText('Dr. S. Banerjee will take CS-301').first().waitFor({ timeout: 20_000 });
    await shot(p, 'admin-notified');
  });

  await step('The student gets the change with the note, and can ask their teacher', async () => {
    student = await demoSignIn(browser, STUDENT, 'Aarav Reddy');
    const p = student.page;
    await p.getByRole('button', { name: /^Notifications/ }).first().click();
    await p.getByText(/Different teacher · CS-301/).locator('visible=true').first().waitFor({ timeout: 30_000 });
    await p.getByText(/bring your OS notebooks/).locator('visible=true').first().waitFor();
    await shot(p, 'student-notified');
    await p.getByRole('button', { name: 'Back' }).first().click();
    await p.getByRole('tab', { name: 'Timetable' }).click();
    await p.waitForTimeout(1500);
    await shot(p, 'student-timetable');
    await p.getByText(/Taken by Dr\. S\. Banerjee — Dr\. Banerjee takes this class/).locator('visible=true').first().waitFor({ timeout: 20_000 });
    await p.getByRole('button', { name: /Ask the teacher about/ }).first().click();
    await p.getByPlaceholder(/lab exam/).fill('Half the class has a lab viva at this time — could we move it?');
    await shot(p, 'student-ask');
    await p.getByRole('button', { name: 'Send' }).click();
    await p.getByText(/Sent\. You’ll get a notification/).waitFor();
    await p.waitForTimeout(1600);
    await p.getByRole('button', { name: /request/ }).first().click();
    await p.getByText('Waiting for reply').waitFor({ timeout: 20_000 });
    await shot(p, 'student-requests');
  });

  await step('Developer console (sandbox): console, audit, flags, institutions', async () => {
    dev = await demoSignIn(browser, DEVELOPER, 'Root Developer');
    const p = dev.page;
    await p.getByText('Kill switches').waitFor({ timeout: 30_000 });
    await p.getByText('SANDBOX').first().waitFor();
    await shot(p, 'dev-console');
    await p.getByRole('tab', { name: 'Audit' }).click();
    await p.getByText('cover.accept').first().waitFor({ timeout: 20_000 });
    await p.getByRole('button', { name: 'Verify the whole chain' }).click();
    await p.getByText(/are intact/).waitFor({ timeout: 20_000 });
    await shot(p, 'dev-audit');
    await p.getByRole('tab', { name: 'Flags' }).click();
    await p.getByText('Strict geofence').first().waitFor();
    await shot(p, 'dev-flags');
    await p.getByRole('tab', { name: 'Tenants' }).click();
    await p.getByText('Demo Institute of Technology').first().waitFor();
    if (await p.getByText('Green Valley College').count()) throw new Error('sandbox sees a real institution');
    await shot(p, 'dev-tenants');
    await p.getByRole('tab', { name: 'Profile' }).click();
    await p.getByText('Server signing key').waitFor();
    await shot(p, 'dev-profile');
  });

  await step('A student account is refused by the developer app', async () => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 880 } });
    const p = await ctx.newPage();
    await p.goto(DEVELOPER);
    await p.getByPlaceholder('you@iit.ac.in').fill('vikram@demo.attendly.app');
    await p.getByRole('button', { name: 'Send OTP' }).click();
    await p.getByText(/developers only/).first().waitFor({ timeout: 20_000 });
    await shot(p, 'dev-refuses-student');
  });

  await browser.close();
  console.log(`\nERRORS: ${JSON.stringify(ERRORS, null, 1)}`);
  process.exit(ERRORS.length ? 1 : 0);
})();

/** Long-press a source, move over the target, release (the apps' PanResponder drag). */
async function drag(page, source, target, whileOver) {
  await source.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error('drag: element not visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(450);
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + a.width / 2 + ((b.x + b.width / 2 - (a.x + a.width / 2)) * i) / steps, a.y + a.height / 2 + ((b.y + b.height / 2 - (a.y + a.height / 2)) * i) / steps);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(250);
  if (whileOver) await whileOver();
  await page.mouse.up();
}
